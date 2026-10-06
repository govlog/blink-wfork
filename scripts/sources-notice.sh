#!/usr/bin/env bash
# Writes web/SOURCES.txt, the notice that goes next to web/rootfs.tar: where to
# get the exact sources of its GPL and LGPL packages. Reads web/rootfs.packages
# and dist/aports.txt (origin and repository of each aport, from fetch-sources.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

CONTACT=${CONTACT:-christopher.amiaud@gmail.com}
{
  cat <<EOF
Logiciels libres du shell / Free software in the shell
======================================================

rootfs.tar est un système Alpine Linux 3.24, que blink émule dans le
navigateur. Il contient des programmes sous GPL et LGPL : bash, busybox,
readline, htop, tcc, libgcc, libstdc++… Leurs sources correspondantes exactes
sont disponibles :

- sur demande, en une archive (rootfs-sources.tar), à $CONTACT,
  pendant au moins trois ans ;
- chez Alpine Linux : l'aport de chaque paquet au commit indiqué ci-dessous
  (APKBUILD et patchs), et les archives amont qu'il cite, sur
  https://distfiles.alpinelinux.org/distfiles/v3.24/

rootfs.tar is an Alpine Linux 3.24 system, emulated by blink in the browser.
It holds GPL and LGPL programs: bash, busybox, readline, htop, tcc, libgcc,
libstdc++… Their exact corresponding sources are available:

- on request, as one archive (rootfs-sources.tar), from $CONTACT,
  for at least three years;
- from Alpine Linux: the aport of each package at the commit below (APKBUILD
  and patches), and the upstream archives it names, at
  https://distfiles.alpinelinux.org/distfiles/v3.24/

The emulator is blink (ISC, https://github.com/jart/blink) with the patches of
blink-wfork (ISC); the terminal is libghostty-vt (MIT).

Paquets / packages:

EOF
  awk 'NR == FNR { repo[$1] = $2; next }
       { lic = $5; for (i = 6; i <= NF; i++) lic = lic " " $i
         printf "%-24s %-26s %s\n    https://gitlab.alpinelinux.org/alpine/aports/-/tree/%s/%s/%s\n",
                $1, $2, lic, $4, repo[$3], $3 }' dist/aports.txt web/rootfs.packages
} > web/SOURCES.txt
echo "OK -> web/SOURCES.txt"
