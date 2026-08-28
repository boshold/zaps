#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
captioned_gif="$(mktemp --suffix=.gif)"
recording_runtime="$(mktemp -d)"
mkdir -p "$recording_runtime/xdg" "$recording_runtime/tmux"

run_isolated() {
  env \
    -u TMUX \
    -u TMUX_PANE \
    XDG_RUNTIME_DIR="$recording_runtime/xdg" \
    TMUX_TMPDIR="$recording_runtime/tmux" \
    "$@"
}

stop_demo() {
  cd "$repo_dir/demo"
  run_isolated "$repo_dir/bin/zaps" down >/dev/null 2>&1 || true
  run_isolated "$repo_dir/bin/zaps" daemon stop >/dev/null 2>&1 || true
}

cleanup() {
  stop_demo
  rm -f "$captioned_gif"
  rm -rf -- "$recording_runtime"
}

trap cleanup EXIT
cd "$repo_dir"
pnpm build
stop_demo

cd "$repo_dir"
run_isolated vhs demo/zaps.tape
ffmpeg \
  -hide_banner \
  -loglevel error \
  -y \
  -i assets/demo.gif \
  -filter_complex "ass=demo/keypresses.ass,split[video][palette_source];[palette_source]palettegen=stats_mode=diff[palette];[video][palette]paletteuse=dither=none" \
  "$captioned_gif"
gifsicle -O3 --lossy=30 --batch "$captioned_gif"
mv "$captioned_gif" assets/demo.gif
