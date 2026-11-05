#!/bin/bash
# Probe: does VS Code render through Wayland shared memory under headless weston, and which protocols does it use?
set -eu
umask 077
mkdir -p "$HOME" /tmp/runtime /tmp/workspace /tmp/user-data/User /tmp/out
export XDG_RUNTIME_DIR=/tmp/runtime LANG=C.UTF-8 LC_ALL=C.UTF-8 SHELL=/bin/bash
unset DISPLAY
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
weston --backend=headless --renderer=pixman --width=1800 --height=1300 --scale="${PROBE_SCALE:-1}" \
  --socket=wayland-1 --idle-time=0 >/tmp/out/weston.log 2>&1 &
weston=$!
for _ in $(seq 1 100); do
  if [ -S /tmp/runtime/wayland-1 ]; then break; fi
  if ! kill -0 "$weston" 2>/dev/null; then cat /tmp/out/weston.log; exit 2; fi
  sleep 0.1
done
test -S /tmp/runtime/wayland-1
export WAYLAND_DISPLAY=wayland-1
printf '%s\n' '{"window.titleBarStyle":"native","window.menuBarVisibility":"classic","telemetry.telemetryLevel":"off","update.mode":"none","workbench.startupEditor":"none","security.workspace.trust.enabled":false,"chat.disableAIFeatures":true}' > /tmp/user-data/User/settings.json
printf 'Wayland probe fixture\n' > /tmp/workspace/first.txt
WAYLAND_DEBUG=1 dbus-run-session -- /tmp/code/code --ozone-platform=wayland --disable-gpu --disable-extensions \
  --user-data-dir=/tmp/user-data --extensions-dir=/tmp/extensions --new-window /tmp/workspace /tmp/workspace/first.txt \
  >/tmp/out/code.log 2>/tmp/out/wayland.log &
sleep "${PROBE_SECONDS:-30}"
echo "== processes"; ps -eo pid,rss,args | grep -E 'code|weston' | grep -v grep | cut -c1-160
echo "== globals advertised"; grep -oE 'wl_registry[@#][0-9]+\.global\([0-9]+, "[a-z_0-9]+"' /tmp/out/wayland.log | sed 's/.*"\(.*\)"/\1/' | sort -u | tr '\n' ' '; echo
echo "== globals bound"; grep -oE 'wl_registry[@#][0-9]+\.bind\([0-9]+, "[a-z_0-9]+"' /tmp/out/wayland.log | sed 's/.*"\(.*\)"/\1/' | sort -u | tr '\n' ' '; echo
echo "== requests by interface"; grep -oE ' -> [a-z_0-9]+[@#][0-9]+\.[a-z_]+' /tmp/out/wayland.log | sed -E 's/ -> ([a-z_0-9]+)[@#][0-9]+\./\1./' | sort | uniq -c | sort -rn | head -60
echo "== buffer formats"; grep -oE 'wl_shm_pool[@#][0-9]+\.create_buffer\([^)]*\)' /tmp/out/wayland.log | sed -E 's/.*\(new id [^,]+, //' | sort | uniq -c | head
echo "== toplevel"; grep -E 'xdg_toplevel[@#][0-9]+\.(set_title|set_app_id|set_min_size)|zxdg_toplevel_decoration_v1[@#][0-9]+\.(set_mode|configure)|xdg_toplevel[@#][0-9]+\.configure' /tmp/out/wayland.log | sort -u | head -12
echo "== stderr (non-protocol)"; grep -vE '^\[' /tmp/out/wayland.log | grep -v '^ *$' | head -15
echo "== weston"; tail -5 /tmp/out/weston.log; echo "== code.log"; grep -v "^\[" /tmp/out/code.log | head -20; echo "== sizes"; wc -l /tmp/out/*.log
