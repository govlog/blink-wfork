# What the patches change in blink

`patches/` holds nine commits on top of jart/blink at `BASE_COMMIT`, applied in
order by `scripts/fetch-blink.sh`. Each patch file carries the full commit
message; this is the short version. Native builds behave as before, apart from
the fixes in patches 1 and 4 (`sendfile()`), and patch 9 (killed threads stop
waiting for i/o); `make check` fails the same tests as upstream.

1. **Fix host page tracking in non-linear memory mode.** Three bugs of the
   host page table used when guest memory can't be mapped linearly (blink -m,
   WebAssembly): a slot number freed as a pointer, a table that grew forever,
   and a `realloc()` racing with lock-free readers.
2. **Track the host fd behind each guest fd.** Every host call goes through
   the fd's recorded host fd. With `HAVE_VIRTUAL_FDS`, blink picks the guest
   numbers itself, which processes sharing one host fd table need. The mode is
   testable natively.
3. **Emulate fork() with threads on WebAssembly** (`HAVE_THREADED_FORK`). The
   child runs on a new thread, with a copy of the parent's address space and a
   host `dup()` of each fd; `wait4()` reaps it from a table of processes.
4. **Implement pipes in-process for threaded fork().** A pipe is a ring
   buffer in blink, with blocking writes, end of file and `EPIPE`, since
   emscripten's pipes don't report end of file between threads.
5. **Add job control to threaded fork().** `kill()`, process groups, the
   terminal's foreground group, stop and continue, `SIGCHLD`; the page turns
   ^C, ^Z and ^\ into signals through `blink_tty_isig()` and
   `blink_tty_signal()`.
6. **Publish /proc entries for threaded fork() on emscripten**, so ps and top
   see the processes.
7. **Reap orphans of threaded fork()**, which init would reap on Linux.
8. **Keep /proc up to date on emscripten**: cpu time, memory, state, load,
   `/proc/stat` per cpu, `sysinfo()`, enough for htop and btop.
9. **Stop the other threads of a forked process when it exits**, and count
   the cpu time of all its threads.
