#!/bin/bash
set -eu
umask 077
mkdir -p "$HOME" /tmp/runtime /tmp/workspace /tmp/user-data/User /tmp/.X11-unix
# Fix the cursor theme and 2x size; libXcursor would otherwise derive 45->48 px from the virtual screen height.
# The agent fingerprints this theme so the host can show native macOS cursors.
# The account's /bin/sh is dash, which has no line editing and echoes arrow keys as ^[[A.
export XDG_RUNTIME_DIR=/tmp/runtime DISPLAY=:11 LANG=C.UTF-8 LC_ALL=C.UTF-8 XCURSOR_THEME=Adwaita XCURSOR_SIZE=48 SHELL=/bin/bash
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
Xvfb :11 -screen 0 4096x2160x24 -nolisten tcp -noreset +extension Composite +extension DAMAGE >/tmp/xorg.log 2>&1 &
xorg=$!
editor=
wm=
cleanup() {
  for process in "$editor" "$wm" "$xorg"; do
    if [ -n "$process" ]; then kill "$process" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
for attempt in $(seq 1 100); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  if ! kill -0 "$xorg" 2>/dev/null; then cat /tmp/xorg.log; exit 2; fi
  sleep 0.1
done
xdpyinfo >/dev/null
openbox >/tmp/wm.log 2>&1 &
wm=$!
# Software WebGL (no GPU in the container) makes xterm.js slow, especially in a separate window; use the DOM renderer.
terminal_gpu=${VSPOD_TERMINAL_GPU:-off}
case "$terminal_gpu" in auto|on|off) ;; *) echo 'Invalid VSPOD_TERMINAL_GPU' >&2; exit 1 ;; esac
printf '%s\n' '{"window.titleBarStyle":"native","window.menuBarVisibility":"classic","telemetry.telemetryLevel":"off","update.mode":"none","workbench.startupEditor":"none","security.workspace.trust.enabled":false,"chat.disableAIFeatures":true,"window.newWindowDimensions":"inherit","editor.cursorBlinking":"solid","terminal.integrated.defaultProfile.linux":"bash","terminal.integrated.gpuAcceleration":"'"$terminal_gpu"'"}' > /tmp/user-data/User/settings.json
printf 'Independent window capture fixture\n' > /tmp/workspace/first.txt
printf 'Second window fixture\n' > /tmp/workspace/second.txt
seq -f 'line %g of the long benchmark file with enough text to fill the editor width' 1 5000 > /tmp/workspace/long.txt
case "${VSPOD_CODE_GPU:-off}" in
  off) gpu_flags=--disable-gpu ;;
  # Chromium's software GL path, for comparing compositing cost with plain software rendering.
  swiftshader) gpu_flags='--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader' ;;
  *) echo 'Unsupported VSPOD_CODE_GPU' >&2; exit 4 ;;
esac
# shellcheck disable=SC2086
dbus-run-session -- /tmp/code/code $gpu_flags --disable-extensions \
  --user-data-dir=/tmp/user-data --extensions-dir=/tmp/extensions \
  --new-window /tmp/workspace /tmp/workspace/first.txt >/tmp/editor.log 2>&1 &
editor=$!
for attempt in $(seq 1 150); do
  window=$(wmctrl -lx 2>/dev/null | awk '$3 == "code.Code" || $3 == "code.code" {print $1; exit}')
  if [ -n "$window" ]; then break; fi
  if ! kill -0 "$editor" 2>/dev/null; then cat /tmp/editor.log; exit 3; fi
  sleep 0.2
done
test -n "$window"
wmctrl -ir "$window" -b remove,maximized_vert,maximized_horz,fullscreen
wmctrl -ir "$window" -e 0,100,100,900,650
echo WINDOW_CAPTURE_READY
# Keep X alive long enough for the agent to report the final window destruction.
wait "$xorg"
exit 5
