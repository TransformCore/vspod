#!/bin/bash
set -eu
umask 077
mkdir -p "$HOME" /tmp/runtime /tmp/workspace /tmp/user-data/User /tmp/.xrdp /tmp/.X11-unix /run/xrdp/sockdir/1000
export XDG_RUNTIME_DIR=/tmp/runtime DISPLAY=:10 LANG=C.UTF-8 LC_ALL=C.UTF-8
case "$(uname -m)" in
  x86_64) platform=linux-x64 ;;
  aarch64) platform=linux-arm64 ;;
  *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac
curl --fail --location --silent --show-error --max-time 180 \
  "https://update.code.visualstudio.com/1.106.3/$platform/stable" -o /tmp/code.tar.gz
mkdir /tmp/code
tar -xzf /tmp/code.tar.gz --strip-components=1 -C /tmp/code
rm /tmp/code.tar.gz
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -keyout /tmp/rdp-key.pem -out /tmp/rdp-cert.pem >/tmp/cert.log 2>&1
cat > /tmp/xrdp.ini <<'EOF'
[Globals]
ini_version=1
fork=false
port=tcp://127.0.0.1:3389
security_layer=tls
crypt_level=high
certificate=/tmp/rdp-cert.pem
key_file=/tmp/rdp-key.pem
ssl_protocols=TLSv1.2,TLSv1.3
autorun=direct
allow_channels=true
allow_multimon=true
bitmap_cache=true
bitmap_compression=true
bulk_compression=true
max_bpp=32
use_fastpath=both
[Logging]
LogFile=/tmp/xrdp.log
LogLevel=INFO
EnableSyslog=false
[Channels]
rdpdr=false
rdpsnd=false
drdynvc=true
cliprdr=true
[direct]
name=direct
lib=libxup.so
ip=127.0.0.1
port=/tmp/.xrdp/xrdp_display_10
code=20
chansrvport=/run/xrdp/sockdir/1000/xrdp_chansrv_socket_10
EOF
/usr/lib/xorg/Xorg :10 -config /etc/X11/xrdp/xorg.conf -noreset -nolisten tcp \
  -logfile /tmp/Xorg.log >/tmp/xorg-stdout.log 2>&1 &
xorg=$!
rdp=
editor=
wm=
channels=
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    for log in /tmp/xorg-stdout.log /tmp/Xorg.log /tmp/xrdp.log /tmp/rdp-stdout.log /tmp/editor.log /tmp/chansrv.log /tmp/xrdp-chansrv.10.log; do
      if [ -f "$log" ]; then echo "=== $log ==="; tail -n 25 "$log"; fi
    done
  fi
  for process in "$rdp" "$editor" "$wm" "$xorg" "$channels"; do
    if [ -n "$process" ]; then kill "$process" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
for attempt in $(seq 1 100); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  if ! kill -0 "$xorg" 2>/dev/null; then exit 2; fi
  sleep 0.1
done
xdpyinfo >/dev/null
openbox >/tmp/wm.log 2>&1 &
wm=$!
printf '%s\n' '{"window.titleBarStyle":"native","window.menuBarVisibility":"hidden","telemetry.telemetryLevel":"off","update.mode":"none","workbench.startupEditor":"none","security.workspace.trust.enabled":false,"chat.disableAIFeatures":true}' > /tmp/user-data/User/settings.json
if [ "${VSPOD_TERMINAL_SMOOTH_SCROLLING:-0}" = 1 ]; then
  sed -i 's/}$/,"terminal.integrated.smoothScrolling":true}/' /tmp/user-data/User/settings.json
  printf '%s\n' '[{"key":"ctrl+c","command":"imagePreview.copyImage","when":"activeCustomEditorId == imagePreview.previewEditor && !filesExplorerFocus && !terminalFocus && !inputFocus"}]' > /tmp/user-data/User/keybindings.json
fi
printf 'Genuine VS Code rendered through xrdp and a native FreeRDP client.\nNo VNC transport is installed in this image.\n' > /tmp/workspace/rdp.txt
dbus-run-session -- /tmp/code/code --disable-gpu --disable-extensions \
  --user-data-dir=/tmp/user-data --extensions-dir=/tmp/extensions \
  --new-window /tmp/workspace /tmp/workspace/rdp.txt >/tmp/editor.log 2>&1 &
editor=$!
for attempt in $(seq 1 150); do
  window=$(wmctrl -lx 2>/dev/null | awk '$3 == "code.Code" || $3 == "code.code" {print $1; exit}')
  if [ -n "$window" ]; then break; fi
  if ! kill -0 "$editor" 2>/dev/null; then exit 3; fi
  sleep 0.2
done
if [ -z "$window" ]; then exit 4; fi
wmctrl -ir "$window" -b add,fullscreen
CHANSRV_LOG_PATH=/tmp /usr/sbin/xrdp-chansrv >/tmp/chansrv.log 2>&1 &
channels=$!
for attempt in $(seq 1 50); do
  if [ -S /run/xrdp/sockdir/1000/xrdp_chansrv_socket_10 ]; then break; fi
  if ! kill -0 "$channels" 2>/dev/null; then cat /tmp/chansrv.log; exit 6; fi
  sleep 0.1
done
test -S /run/xrdp/sockdir/1000/xrdp_chansrv_socket_10
/usr/sbin/xrdp --nodaemon --config /tmp/xrdp.ini >/tmp/rdp-stdout.log 2>&1 &
rdp=$!
for attempt in $(seq 1 50); do
  if grep -q '0100007F:0D3D .* 0A ' /proc/net/tcp; then break; fi
  if ! kill -0 "$rdp" 2>/dev/null; then exit 7; fi
  sleep 0.1
done
grep -q '0100007F:0D3D .* 0A ' /proc/net/tcp
echo RDP_SPIKE_READY
wait -n "$rdp" "$editor" "$xorg"
exit 5
