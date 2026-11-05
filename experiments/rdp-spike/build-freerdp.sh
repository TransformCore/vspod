#!/bin/bash
set -euo pipefail
if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo 'Usage: bash build-freerdp.sh <user-owned-build-directory> [cmake-executable] [openssl-prefix]' >&2
  exit 2
fi
mkdir -p "$1"
root=$(cd "$1" && pwd)
cmake=${2:-cmake}
openssl=${3:-/usr/local/opt/openssl@3}
version=3.20.2
archive="$root/freerdp.tar.gz"
checksum=0b4f794845ece598ee3665847eeecba9deb56647000959529492152336a6253a
if [ ! -f "$archive" ]; then
  curl --fail --location --show-error --max-time 180 \
    "https://github.com/FreeRDP/FreeRDP/archive/refs/tags/$version.tar.gz" -o "$archive.download"
  mv "$archive.download" "$archive"
fi
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
if [ ! -d "$root/FreeRDP-$version" ]; then
  tar -xzf "$archive" -C "$root"
fi
"$cmake" -S "$root/FreeRDP-$version" -B "$root/native" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$root/install" \
  -DWITH_CLIENT=ON -DWITH_CLIENT_COMMON=ON \
  -DWITH_X11=OFF -DWITH_WAYLAND=OFF -DWITH_SDL=OFF \
  -DWITH_FFMPEG=OFF -DWITH_OPENH264=OFF -DWITH_CAIRO=OFF \
  -DWITH_CUPS=OFF -DWITH_PCSC=OFF -DWITH_FUSE=OFF \
  -DWITH_JPEG=OFF -DWITH_ALSA=OFF -DWITH_PULSE=OFF \
  -DWITH_SWSCALE=OFF -DWITH_SERVER=OFF -DWITH_SAMPLE=OFF \
  -DWITH_MANPAGES=OFF -DWITH_AAD=OFF -DWITH_KRB5=OFF \
  -DWITH_PKCS11=OFF -DWITH_WEBVIEW=OFF -DWITH_LIBUSB=OFF \
  -DCHANNEL_URBDRC=OFF -DOPENSSL_ROOT_DIR="$openssl"
"$cmake" --build "$root/native" --parallel 4
"$cmake" --install "$root/native"
printf 'FreeRDP prefix: %s/install\n' "$root"
