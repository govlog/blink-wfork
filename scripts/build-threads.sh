#!/usr/bin/env bash
# The threads build of blink, the one with fork(), pipes and wait4():
# -pthread -sPROXY_TO_PTHREAD runs main() on a Web Worker, and each forked child
# gets its own pthread and a private copy of the address space.
# Output: web/blink.threads.{js,wasm}. Needs Docker (emscripten/emsdk image).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
[ -d blink ] || { echo "run scripts/fetch-blink.sh first"; exit 1; }

docker run --rm -v "$ROOT/blink":/src -w /src emscripten/emsdk:${EMSDK:-6.0.11} bash -euc '
  emconfigure ./configure >/tmp/cfg.log 2>&1 || true
  # enable threads (configure defines DISABLE_THREADS under emscripten)
  sed -i "s@^#define DISABLE_THREADS@// #define DISABLE_THREADS@" config.h
  grep -E "DISABLE_THREADS|DISABLE_JIT" config.h | head
  mkdir -p o/thr
  SRCS=$(ls blink/*.c | grep -vE "blinkenlights\.c|oneoff\.c")
  emcc -O2 -DNDEBUG -DDISABLE_JIT -D_GNU_SOURCE -pthread -I. -Ithird_party/libz \
    $SRCS third_party/libz/*.c \
    -o o/thr/blink.js \
    -sMODULARIZE=1 -sEXPORT_NAME=createBlink \
    -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 \
    -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=0 \
    -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sSTACK_SIZE=8MB \
    -sEXPORTED_RUNTIME_METHODS=callMain,FS,TTY,ENV
'

cp blink/o/thr/blink.js   web/blink.threads.js
cp blink/o/thr/blink.wasm web/blink.threads.wasm
echo "OK -> web/blink.threads.{js,wasm}"
ls -lh web/blink.threads.js web/blink.threads.wasm
