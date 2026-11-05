#!/bin/bash
set -eu
umask 077
read -r session
if ! [[ "$session" =~ ^[a-f0-9]{64}$ ]]; then exit 1; fi
mkdir -p "$HOME" /tmp/runtime /tmp/workspace /tmp/www /tmp/user-data/User
chmod 700 /tmp/runtime
export XDG_RUNTIME_DIR=/tmp/runtime DISPLAY=:99
case "$(uname -m)" in
  x86_64) platform=linux-x64 ;;
  aarch64) platform=linux-arm64 ;;
  *) exit 1 ;;
esac
curl --fail --location --silent --show-error --max-time 180 \
  "https://update.code.visualstudio.com/1.106.3/$platform/stable" -o /tmp/code.tar.gz
mkdir /tmp/code
tar -xzf /tmp/code.tar.gz --strip-components=1 -C /tmp/code
rm /tmp/code.tar.gz
vnc_password=$(head -c 6 /dev/urandom | base64)
printf '%s\n' "$vnc_password" | tigervncpasswd -f > /tmp/vnc-password
chmod 600 /tmp/vnc-password
Xtigervnc :99 -geometry 1280x800 -depth 24 -localhost yes \
  -SecurityTypes VncAuth -PasswordFile /tmp/vnc-password -rfbport 5999 \
  -AlwaysShared -AcceptCutText=0 -SendCutText=0 >/tmp/display.log 2>&1 &
display_pid=$!
for attempt in $(seq 1 100); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo >/dev/null
clipboard_pid=
if [ "${VSPOD_CLIPBOARD_TEST:-}" = 1 ]; then
  python3 /opt/spike/clipboard-agent.py serve >/tmp/clipboard-agent.log 2>&1 &
  clipboard_pid=$!
fi
openbox >/tmp/window-manager.log 2>&1 &
wm_pid=$!
for attempt in $(seq 1 100); do
  if wmctrl -m >/dev/null 2>&1; then break; fi
  sleep 0.1
done
wmctrl -m >/dev/null
printf '%s\n' '{"window.titleBarStyle":"native","window.menuBarVisibility":"hidden","telemetry.telemetryLevel":"off","update.mode":"none","workbench.startupEditor":"none"}' > /tmp/user-data/User/settings.json
printf 'This editor and every extension process run inside the disposable container.\nResize the native host window to resize the remote display.\n' > /tmp/workspace/spike.txt
touch /tmp/workspace/clipboard.txt /tmp/workspace/clipboard.md
# Only the explicitly selected synthetic clipboard/drop tests bypass trust.
trust_args=()
extension_args=(--disable-extensions)
if [ "${VSPOD_CLIPBOARD_TEST:-}" = 1 ]; then
  trust_args=(--disable-workspace-trust)
  extension_args=()
  printf '%s\n' '[{"key":"ctrl+alt+i","command":"imagePreview.copyImage"},{"key":"ctrl+alt+e","command":"workbench.files.action.showActiveFileInExplorer"},{"key":"ctrl+alt+f","command":"workbench.files.action.focusFilesExplorer"}]' > /tmp/user-data/User/keybindings.json
fi
dbus-run-session -- /tmp/code/code --disable-gpu "${extension_args[@]}" \
  "${trust_args[@]}" \
  --user-data-dir=/tmp/user-data --extensions-dir=/tmp/extensions \
  --new-window /tmp/workspace /tmp/workspace/spike.txt >/tmp/editor.log 2>&1 &
editor_pid=$!
window=
for attempt in $(seq 1 150); do
  if ! kill -0 "$editor_pid" 2>/dev/null; then cat /tmp/editor.log; exit 2; fi
  window=$(wmctrl -lx | awk '$3 == "code.Code" || $3 == "code.code" {print $1; exit}')
  if [ -n "$window" ]; then break; fi
  sleep 0.2
done
if [ -z "$window" ]; then cat /tmp/editor.log; exit 3; fi
wmctrl -ir "$window" -b add,fullscreen
websockify 127.0.0.1:6081 127.0.0.1:5999 >/tmp/websockify.log 2>&1 &
proxy_pid=$!
cat > /tmp/www/index.html <<EOF
<!doctype html><meta charset="utf-8"><title>VSPod Desktop Spike</title>
<style>html,body,#display{margin:0;width:100%;height:100%;overflow:hidden;background:#181818}#status{position:absolute;color:white;background:#333;font:14px sans-serif;z-index:2}</style>
<div id="status">Connecting to isolated editor...</div><div id="display"></div>
<script type="module">
import RFB from '/novnc/core/rfb.js';
const status = document.getElementById('status');
const rfb = new RFB(document.getElementById('display'),
  'ws://' + location.host + '/socket', {credentials:{password:'$vnc_password'}});
rfb.resizeSession = true;
rfb.scaleViewport = true;
rfb.viewOnly = false;
rfb.addEventListener('connect', () => {status.hidden=true; window.spikeConnected=true;});
rfb.addEventListener('disconnect', () => {window.spikeConnected=false;status.hidden=false;status.textContent='Display disconnected';});
rfb.addEventListener('securityfailure', () => {status.hidden=false;status.textContent='Display authentication failed';});
</script>
EOF
cat > /tmp/nginx.conf <<EOF
pid /tmp/nginx.pid;
error_log /tmp/nginx-error.log;
events {}
http {
  access_log off;
  include /etc/nginx/mime.types;
  client_body_temp_path /tmp/nginx-client;
  proxy_temp_path /tmp/nginx-proxy;
  fastcgi_temp_path /tmp/nginx-fastcgi;
  uwsgi_temp_path /tmp/nginx-uwsgi;
  scgi_temp_path /tmp/nginx-scgi;
  server {
    listen 8080;
    if (\$cookie_vspod_spike != "$session") { return 403; }
    location / { root /tmp/www; }
    location /novnc/ { alias /usr/share/novnc/; }
    location /socket {
      if (\$http_origin != "http://\$http_host") { return 403; }
      proxy_pass http://127.0.0.1:6081;
      proxy_http_version 1.1;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 3600s;
    }
  }
}
EOF
nginx -c /tmp/nginx.conf -g 'daemon off;' >/tmp/nginx-stdout.log 2>&1 &
gateway_pid=$!
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    for log in /tmp/nginx-stdout.log /tmp/nginx-error.log /tmp/websockify.log /tmp/display.log /tmp/editor.log /tmp/clipboard-agent.log; do
      if [ -f "$log" ]; then echo "=== $log ===" >&2; tail -n 25 "$log" >&2; fi
    done
  fi
  kill "${component_pids[@]}" "$wm_pid" 2>/dev/null || true
}
component_pids=("$gateway_pid" "$proxy_pid" "$editor_pid" "$display_pid")
if [ -n "$clipboard_pid" ]; then component_pids+=("$clipboard_pid"); fi
trap cleanup EXIT
echo 'APP_ONLY_DISPLAY=ready'
wait -n "${component_pids[@]}"
echo 'A display component exited unexpectedly.' >&2
exit 4
