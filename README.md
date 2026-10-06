# blink-wfork

A real Linux userland in the browser: bash, busybox, htop, btop and a C compiler
from Alpine Linux, x86-64 binaries emulated by
[blink](https://github.com/jart/blink) compiled to WebAssembly, in a terminal
drawn by [libghostty-vt](https://github.com/ghostty-org/ghostty). No server
does the work: once the page is loaded, everything runs in the tab.

Upstream blink runs a single process in the browser, because there is no
`fork()` there: a shell can only run its builtins. The patches in `patches/`
add what a shell needs, on top of emscripten's threads, without a kernel:
`fork()` on a thread with a copy of the address space, pipes, job control (^C,
^Z, `fg`, `kill %1`), orphan reaping, and a `/proc` that ps, top, htop and
btop can read. [CHANGES.md](CHANGES.md) lists them.

```
ls -la / | sort -k5 -n | tail -3       # pipelines
sleep 30 &  jobs  kill %1               # job control
htop                                    # mouse clicks work
tcc -run hi.c                           # a C compiler
```

Live: [shell.blop.foo](https://shell.blop.foo/).

## Try it

`web/` holds the page and the prebuilt emulator and terminal. The guest system,
`web/rootfs.tar`, is not in git: build it, or take it from the latest release.

```
make rootfs     # Alpine userland -> web/rootfs.tar (Docker)
# or: curl -Lo web/rootfs.tar https://github.com/govlog/blink-wfork/releases/latest/download/rootfs.tar
make serve      # http://localhost:8777
```

The page needs `SharedArrayBuffer`, so it must be cross-origin isolated:
send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, or let `coi-serviceworker.js`
reload the page once with them, which works on any static host. Add
`?cmd=busybox` to the URL for busybox ash instead of bash.

## Build from source

Nothing is vendored: blink comes from upstream at `BASE_COMMIT`, and every
build step runs in Docker (`emscripten/emsdk:6.0.11`, `alpine:3.24.2` pinned
by digest).

```
make fetch      # clone jart/blink at BASE_COMMIT, apply patches/ -> blink/
make build      # web/blink.threads.{js,wasm}
make rootfs     # web/rootfs.tar and web/rootfs.packages; add packages with PKGS="vim git"
make sources    # dist/rootfs-sources.tar, the exact sources of the rootfs packages,
                # and web/SOURCES.txt, the offer of those sources (CONTACT=you@example.com)
```

## Limits

- No network: the guest has no sockets to the outside, so no `apk add` in
  the browser. Add packages with `make rootfs PKGS=…`.
- Every instruction is interpreted (blink's JIT writes native code, which a
  browser can't run): count about 20 ms for a fork and exec, and expect
  CPU-bound programs to be slow.

## Layout

```
BASE_COMMIT          upstream blink commit the patches apply to
patches/             the nine commits, also on the wasm-fork branch of github.com/govlog/blink
scripts/             fetch, build, rootfs and sources scripts
web/index.html       the page: tabs, CRT effect, terminal, and the glue to blink
web/ghostty-*        the terminal (ghostty-web-native: libghostty-vt in wasm)
web/index-xterm.html the same page with xterm.js
LICENSES/            the license texts of the third-party components
```

## Licenses

The patches, scripts and pages are under the ISC license, like blink.
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists every component, its
license, and its text in `LICENSES/`. The rootfs is Alpine Linux: it holds GPL
and LGPL programs, so whoever distributes `rootfs.tar` must offer their sources
too. Each release carries them, as `rootfs-sources.tar`, next to `rootfs.tar`.

## Credits

Written mostly by Claude (Claude Code, Anthropic), under the direction of
Christopher Amiaud. blink is the work of Justine Tunney and its contributors.
