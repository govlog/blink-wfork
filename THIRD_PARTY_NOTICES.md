# Third-party notices

blink-wfork is made of the projects below. Each keeps its own license; the
full texts are in `LICENSES/`, named in the last column.

## The emulator: `web/blink.threads.{js,wasm}`

Built by `make fetch build` from [jart/blink](https://github.com/jart/blink) at
`BASE_COMMIT`, with the patches in `patches/`, by emscripten.

| Component | License | Notice | Text |
|---|---|---|---|
| blink | ISC | Copyright 2022 Justine Alexandra Roberts Tunney; `blink/hostfs.c`, `vfs.c`, `devfs.c`, `procfs.c` copyright 2023 Trung Nguyen. | `LICENSE` |
| The patches in `patches/` | ISC | Copyright 2026 Christopher Amiaud, same terms as blink. | `LICENSE` |
| Intel XED decoder tables (`blink/x86.c`) | Apache-2.0 | Copyright 2018 Intel Corporation. | `LICENSES/Apache-2.0.txt` |
| getopt (`blink/getopt.c`) | BSD-3-Clause | Copyright (c) 1987, 1993, 1994 The Regents of the University of California. | `LICENSES/getopt-BSD-3-Clause.txt` |
| zlib (`third_party/libz`) | Zlib | Copyright (C) 1995-2022 Jean-loup Gailly and Mark Adler. | `LICENSES/zlib.txt` |
| emscripten runtime | MIT / University of Illinois NCSA | Copyright (c) 2010-2014 Emscripten authors. | `LICENSES/emscripten.txt` |
| musl, the libc of emscripten | MIT | Copyright © 2005-2020 Rich Felker, et al. | `LICENSES/musl.txt` |
| compiler-rt | Apache-2.0 WITH LLVM-exception | The LLVM project. | `LICENSES/compiler-rt.txt` |
| dlmalloc | CC0 | Doug Lea, public domain. | |

## The terminal: `web/ghostty-web.js`, `web/ghostty-vt.wasm`

Built from ghostty-web-native, with libghostty-vt from ghostty at its
`GHOSTTY_COMMIT` (`35a81a9`).

| Component | License | Notice | Text |
|---|---|---|---|
| ghostty-web-native | MIT | Copyright (c) 2026 Christopher Amiaud. | `LICENSES/ghostty-web-native.txt` |
| libghostty-vt, from [ghostty](https://github.com/ghostty-org/ghostty) | MIT | Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors. | `LICENSES/ghostty.txt` |
| [uucode](https://github.com/jacobsandlund/uucode) 0.2.0, the Unicode tables of ghostty | MIT | Copyright (c) 2026 Jacob Sandlund; its UTF-8 decoder copyright (c) 2008-2009 Bjoern Hoehrmann. | `LICENSES/uucode.txt` |
| Unicode Character Database, in uucode's tables | Unicode-3.0 | Copyright © 1991-2025 Unicode, Inc. | `LICENSES/unicode.txt` |
| Zig standard library and compiler-rt, linked into the wasm | MIT | Copyright (c) Zig contributors. | `LICENSES/zig.txt` |
| Parts of [coder/ghostty-web](https://github.com/coder/ghostty-web) (`input-handler.ts`, `event-emitter.ts`, `addons/fit.ts`, key enums) | MIT | Copyright (c) 2025 Coder. | `LICENSES/coder-ghostty-web.txt` |

## The page: `web/*.html`, `web/coi-serviceworker.js`, `web/xterm.*`

| Component | License | Notice | Text |
|---|---|---|---|
| The pages and their scripts | ISC | Copyright 2026 Christopher Amiaud. | `LICENSE` |
| [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) 0.1.6 | MIT | Copyright (c) 2021 Guido Zuidhof. | `LICENSES/coi-serviceworker.txt` |
| [xterm.js](https://github.com/xtermjs/xterm.js) 5.1.0 (fallback page `index-xterm.html`) | MIT | Copyright (c) 2017-2019, The xterm.js authors; (c) 2014-2016, SourceLair Private Company; (c) 2012-2013, Christopher Jeffrey. | `LICENSES/xterm.js.txt` |

## The guest system: `rootfs.tar`

Not in git: `make rootfs` builds it, and each release carries a prebuilt one.
It is an Alpine Linux userland, built from the pinned Alpine image and
packages. `web/rootfs.packages` lists every package with its version, the
Alpine origin, the aports commit it was built from, and its license; the same
list is in the guest at `/usr/share/rootfs.packages`. Among others: bash
(GPL-3.0-or-later), busybox (GPL-2.0-only), readline (GPL-3.0-or-later), htop
(GPL-2.0-or-later), libgcc and libstdc++ (GPL with the GCC Runtime Library
Exception), tcc (LGPL-2.1-or-later), musl (MIT), ncurses (X11), btop
(Apache-2.0).

`make sources` writes `dist/rootfs-sources.tar`: the exact corresponding
sources of all those packages, that is each aport (APKBUILD and patches) at its
commit, and the upstream tarballs it names, checked against its sha512sums.
Each release carries it next to `rootfs.tar`. Whoever distributes `rootfs.tar`
must offer those sources along with it; `web/SOURCES.txt`, written by
`make sources`, is such an offer, to serve next to `rootfs.tar`.
