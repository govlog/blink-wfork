#!/usr/bin/env bash
# Single-threaded reference build of blink. Without threads, fork() fails with
# ENOSYS: no pipelines, no subshells, no external commands, a single process.
# The real multi-process bash needs build-threads.sh.
# Output: web/blink.singlethread.{js,wasm}.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
[ -d blink ] || { echo "run scripts/fetch-blink.sh first"; exit 1; }

docker run --rm -v "$ROOT/blink":/src -w /src emscripten/emsdk:${EMSDK:-6.0.11} bash -euc '
  emconfigure ./configure >/tmp/cfg.log 2>&1 || true
  mkdir -p o/web
  SRCS=$(ls blink/*.c | grep -vE "blinkenlights\.c|oneoff\.c")
  emcc -O2 -DNDEBUG -DDISABLE_JIT -I. -Ithird_party/libz \
    $SRCS third_party/libz/*.c \
    -o o/web/blink.js \
    -sMODULARIZE=1 -sEXPORT_NAME=createBlink \
    -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sASYNCIFY \
    -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sSTACK_SIZE=8MB \
    -sEXPORTED_RUNTIME_METHODS=callMain,FS,TTY,ENV
'

cp blink/o/web/blink.js   web/blink.singlethread.js
cp blink/o/web/blink.wasm web/blink.singlethread.wasm
echo "OK -> web/blink.singlethread.{js,wasm}  (no fork: a single process)"
ls -lh web/blink.singlethread.js web/blink.singlethread.wasm
