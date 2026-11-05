#!/bin/bash
set -eu
umask 077
if [ "$#" -eq 0 ]; then
  echo 'Usage: app-runner image /absolute/application [arguments...]' >&2
  exit 1
fi
mkdir -p "$HOME" /tmp/runtime
export XDG_RUNTIME_DIR=/tmp/runtime LANG=C.UTF-8 LC_ALL=C.UTF-8 SHELL=/bin/bash
export WAYLAND_DISPLAY=wayland-1
unset DISPLAY
/opt/app-runner/vspod-compositor >/tmp/compositor.log 2>&1 &
compositor=$!
application=
cleanup() {
  for process in "$application" "$compositor"; do
    if [ -n "$process" ]; then kill "$process" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
for _ in $(seq 1 100); do
  if [ -S /tmp/runtime/wayland-1 ] && [ -S /tmp/runtime/vspod-host.sock ]; then break; fi
  if ! kill -0 "$compositor" 2>/dev/null; then cat /tmp/compositor.log >&2; exit 2; fi
  sleep 0.1
done
test -S /tmp/runtime/wayland-1
test -S /tmp/runtime/vspod-host.sock
dbus-run-session -- "$@" >/tmp/application.log 2>&1 &
application=$!
for _ in $(seq 1 150); do
  if grep -q VSPOD_MAPPED /tmp/compositor.log; then break; fi
  if ! kill -0 "$application" 2>/dev/null; then cat /tmp/application.log >&2; exit 3; fi
  if ! kill -0 "$compositor" 2>/dev/null; then cat /tmp/compositor.log >&2; exit 2; fi
  sleep 0.2
done
if ! grep -q VSPOD_MAPPED /tmp/compositor.log; then
  echo 'Application did not map a Wayland window' >&2
  cat /tmp/application.log >&2
  exit 4
fi
echo APP_RUNNER_READY
# The compositor outlives a host attachment; exiting the application ends the session.
while kill -0 "$application" 2>/dev/null && kill -0 "$compositor" 2>/dev/null; do sleep 0.2; done
if ! kill -0 "$compositor" 2>/dev/null; then wait "$compositor"; else wait "$application"; fi
