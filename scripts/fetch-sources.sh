#!/usr/bin/env bash
# Gathers the exact corresponding sources of the packages in web/rootfs.tar, which
# the GPL and LGPL packages in it require to go along with it: for each Alpine
# origin listed in web/rootfs.packages, its aport (APKBUILD and patches) at the
# commit Alpine built it from, and the upstream tarballs it names, checked
# against the APKBUILD's sha512sums by abuild.
#
# Output: dist/rootfs-sources.tar, dist/aports.txt (origin and repository of
# each aport), and web/SOURCES.txt, the notice to serve next to rootfs.tar.
set -euo pipefail
cd "$(dirname "$0")/.."

ALPINE=${ALPINE:-alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6}
mkdir -p dist
cp web/rootfs.packages dist/rootfs.packages

docker run --rm -v "$PWD/dist:/out" "$ALPINE" sh -euc '
  apk add -q abuild curl tar
  export DISTFILES_MIRROR=https://distfiles.alpinelinux.org/distfiles/v3.24
  mkdir -p /src && cd /tmp && : > /out/aports.txt
  # columns: package version origin commit license...
  awk "{ print \$3, \$4 }" /out/rootfs.packages | sort -u | while read -r origin commit; do
    found=
    for repo in main community; do
      rm -rf aport && mkdir aport
      curl -fsSL "https://gitlab.alpinelinux.org/alpine/aports/-/archive/$commit/aports-$commit.tar.gz?path=$repo/$origin" |
        tar xz -C aport --strip-components=3 2>/dev/null || continue
      [ -f aport/APKBUILD ] || continue
      found=$repo
      break
    done
    [ -n "$found" ] || { echo "missing aport: $origin@$commit" >&2; exit 1; }
    echo "$origin $found" >> /out/aports.txt
    mkdir -p "/src/$origin"
    cp -r aport/. "/src/$origin/"
    (cd "/src/$origin" && SRCDEST="/src/$origin" abuild -F fetch verify >/dev/null && rm -rf src)
    echo "$found/$origin@$commit: $(du -sh "/src/$origin" | cut -f1)"
  done
  cp /out/rootfs.packages /src/
  tar cf /out/rootfs-sources.tar -C /src .
'
echo "OK -> dist/rootfs-sources.tar ($(du -h dist/rootfs-sources.tar | cut -f1))"
scripts/sources-notice.sh
