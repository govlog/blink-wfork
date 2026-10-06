#!/usr/bin/env bash
# Builds the guest system: Alpine with bash, busybox (ps, top, vi, awk, sed…),
# tcc (Tiny C Compiler) and the musl headers, so that `tcc -run hello.c` works,
# plus the packages in PKGS. Left out, since tcc -run doesn't need them: the
# static libc.a (dynamic linking through ld-musl is enough), openssl, apk,
# pkgconf, man and doc pages.
#
# Outputs: web/rootfs.tar, and web/rootfs.packages (package, version, origin,
# aports commit, license; also in the guest at /usr/share/rootfs.packages),
# written before the apk database is removed: scripts/fetch-sources.sh reads it
# to gather the exact sources that the GPL and LGPL packages require.
set -euo pipefail
cd "$(dirname "$0")/.."

# Alpine pinned by digest: the same base at each build.
ALPINE=${ALPINE:-alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6}
# Alpine packages on top of the base, e.g. make rootfs PKGS="htop btop vim"
PKGS=${PKGS-htop btop}
img=blink-wfork-rootfs-dev
# btop runs without its network box, which lists interfaces through netlink:
# blink doesn't emulate netlink, and btop 1.4 crashes when getifaddrs() fails.
docker build -t "$img" --build-arg ALPINE="$ALPINE" --build-arg PKGS="$PKGS" -f - . >/dev/null <<'DOCKERFILE'
ARG ALPINE
FROM ${ALPINE}
ARG PKGS
RUN apk add --no-cache bash tcc musl-dev tcc-libs-static readline ncurses-libs $PKGS \
 && if [ -e /usr/bin/btop ]; then mkdir -p /root/.config/btop \
      && echo 'shown_boxes = "cpu mem proc"' > /root/.config/btop/btop.conf; fi \
 && awk -F: '/^P:/{p=$2} /^V:/{v=$2} /^o:/{o=$2} /^c:/{c=$2} /^L:/{l=$2} /^$/{if(p)print p, v, o, c, l; p=""}' \
       /lib/apk/db/installed | sort > /usr/share/rootfs.packages \
 && rm -rf /var/cache/apk/* /lib/apk/db /usr/share/man /usr/share/doc /usr/share/info \
    /usr/lib/libc.a \
    /usr/lib/libcrypto.so* /usr/lib/libssl.so* /usr/lib/ossl-modules /usr/lib/engines-3 \
    /usr/lib/libapk.so* /usr/lib/libpkgconf.so* /usr/bin/pkgconf /usr/bin/pkg-config \
    /etc/ssl /etc/ssl1.1 2>/dev/null || true
DOCKERFILE
cid=$(docker create "$img")
docker cp "$cid":/usr/share/rootfs.packages web/rootfs.packages
docker export "$cid" -o web/rootfs.tar
docker rm "$cid" >/dev/null

echo "OK -> web/rootfs.tar ($(du -h web/rootfs.tar | cut -f1)), $(wc -l < web/rootfs.packages) packages in web/rootfs.packages"
