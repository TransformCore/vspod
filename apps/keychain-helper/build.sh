#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_dir="$script_dir/build"
mkdir -p "$output_dir"
swiftc "$script_dir/Sources/main.swift" -framework Security -o "$output_dir/vspod-keychain-helper"
chmod 700 "$output_dir/vspod-keychain-helper"
