#!/bin/bash
# VS Code acceptance fixture only. The runner itself never downloads an editor or creates workspace files.
set -eu
umask 077
mkdir -p "$HOME" /tmp/runtime /tmp/workspace /tmp/user-data/User
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
# Software WebGL (no GPU in the container) makes xterm.js slow, especially in a separate window; use the DOM renderer.
terminal_gpu=${VSPOD_TERMINAL_GPU:-off}
case "$terminal_gpu" in auto|on|off) ;; *) echo 'Invalid VSPOD_TERMINAL_GPU' >&2; exit 1 ;; esac
printf '%s\n' '{"window.titleBarStyle":"native","window.menuBarVisibility":"classic","telemetry.telemetryLevel":"off","update.mode":"none","workbench.startupEditor":"none","security.workspace.trust.enabled":false,"chat.disableAIFeatures":true,"window.newWindowDimensions":"inherit","editor.cursorBlinking":"solid","terminal.integrated.defaultProfile.linux":"bash","terminal.integrated.gpuAcceleration":"'"$terminal_gpu"'"}' > /tmp/user-data/User/settings.json
printf 'Independent window capture fixture\n' > /tmp/workspace/first.txt
printf 'Second window fixture\n' > /tmp/workspace/second.txt
seq -f 'line %g of the long benchmark file with enough text to fill the editor width' 1 5000 > /tmp/workspace/long.txt
ln -s /tmp/application.log /tmp/editor.log
exec /bin/bash /opt/app-runner/entrypoint.sh "$@"
