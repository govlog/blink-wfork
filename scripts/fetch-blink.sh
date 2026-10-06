#!/usr/bin/env bash
# Rebuilds the exact source tree of blink-wfork: clone jart/blink, check out the
# pinned commit, apply patches/. Nothing is vendored: the whole change is patches/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BASE=$(tr -d '[:space:]' < BASE_COMMIT)
DEST=${1:-blink}

if [ -d "$DEST/.git" ]; then
  echo "==> '$DEST' already exists (rm -rf $DEST to fetch again)"; exit 0
fi

echo "==> clone jart/blink"
git clone https://github.com/jart/blink "$DEST"
echo "==> checkout $BASE"
git -C "$DEST" checkout --quiet "$BASE"
echo "==> apply patches/*.patch"
for p in "$ROOT"/patches/*.patch; do
  git -C "$DEST" apply "$p"
done

echo "OK: $DEST = jart/blink@${BASE:0:12} + patches/*.patch"
echo "    then: make build && make serve"
