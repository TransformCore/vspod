#!/bin/bash
set -eu

mkdir -p "$HOME" /tmp/runtime /tmp/workspace
chmod 700 /tmp/runtime
export XDG_RUNTIME_DIR=/tmp/runtime
printf 'container uid=%s architecture=%s\n' "$(id -u)" "$(uname -m)"
grep -E 'NoNewPrivs|Seccomp' /proc/self/status
if unshare -Ur true; then
  echo 'USER_NAMESPACE_PROBE=available'
else
  echo 'USER_NAMESPACE_PROBE=blocked'
fi

case "$(uname -m)" in
  x86_64) platform=linux-x64 ;;
  aarch64) platform=linux-arm64 ;;
  *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac
echo 'Downloading genuine VS Code from Microsoft into disposable container scratch.'
curl --fail --location --silent --show-error --max-time 180 \
  "https://update.code.visualstudio.com/1.106.3/$platform/stable" -o /tmp/code.tar.gz
mkdir /tmp/code
tar -xzf /tmp/code.tar.gz --strip-components=1 -C /tmp/code
rm /tmp/code.tar.gz
grep -m 1 '"version":' /tmp/code/resources/app/package.json

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/display.log 2>&1 &
display_pid=$!
editor_pid=
wm_pid=
cleanup() {
  if [ -n "$editor_pid" ]; then kill "$editor_pid" 2>/dev/null || true; fi
  if [ -n "$wm_pid" ]; then kill "$wm_pid" 2>/dev/null || true; fi
  kill "$display_pid" 2>/dev/null || true
}
trap cleanup EXIT
for attempt in $(seq 1 50); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo >/dev/null
openbox >/tmp/window-manager.log 2>&1 &
wm_pid=$!
mkdir -p /tmp/user-data/User
printf '%s\n' '{"window.titleBarStyle":"native","window.menuBarVisibility":"hidden","telemetry.telemetryLevel":"off","update.mode":"none"}' \
  > /tmp/user-data/User/settings.json
printf 'Disposable desktop spike. No repository or host credentials are mounted.\n' > /tmp/workspace/README.txt
echo 'Launching VS Code with its sandbox enabled; no --no-sandbox flag.'
dbus-run-session -- /tmp/code/code --disable-gpu --disable-extensions \
  --user-data-dir=/tmp/user-data --extensions-dir=/tmp/extensions \
  --new-window /tmp/workspace >/tmp/editor.log 2>&1 &
editor_pid=$!
for attempt in $(seq 1 100); do
  if ! kill -0 "$editor_pid" 2>/dev/null; then
    status=0
    wait "$editor_pid" || status=$?
    cat /tmp/editor.log
    printf 'ELECTRON_STARTUP=failed exit=%s\n' "$status"
    echo 'Checking namespace-only sandbox (setuid fallback disabled, Chromium sandbox still required).'
    namespace_status=0
    timeout 15s dbus-run-session -- /tmp/code/code --disable-setuid-sandbox \
      --disable-gpu --disable-extensions --user-data-dir=/tmp/namespace-user-data \
      --extensions-dir=/tmp/extensions --new-window /tmp/workspace \
      >/tmp/namespace-editor.log 2>&1 || namespace_status=$?
    cat /tmp/namespace-editor.log
    printf 'NAMESPACE_ONLY_STARTUP_EXIT=%s\n' "$namespace_status"
    exit 2
  fi
  if xwininfo -root -tree | grep -q 'Visual Studio Code'; then
    echo 'ELECTRON_STARTUP=window-created'
    xwininfo -root -tree
    echo 'No display client or resizing acceptance has been run by this prerequisite probe.'
    exit 0
  fi
  sleep 0.2
done
cat /tmp/editor.log
echo 'ELECTRON_STARTUP=no-window-before-deadline'
exit 3
