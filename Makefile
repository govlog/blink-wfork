# blink-wfork: a Linux userland in the browser (see README.md)
PORT ?= 8777
PKGS ?= htop btop

.PHONY: help all fetch build build-single rootfs sources serve clean

help:
	@echo "make serve         serve web/ at http://localhost:$(PORT)"
	@echo "make fetch         clone jart/blink at BASE_COMMIT and apply patches/ -> blink/"
	@echo "make build         (Docker) build the fork-enabled emulator -> web/blink.threads.{js,wasm}"
	@echo "make build-single  (Docker) single-threaded reference build, without fork()"
	@echo "make rootfs        (Docker) Alpine userland + PKGS=\"$(PKGS)\" -> web/rootfs.tar"
	@echo "make sources       (Docker) exact sources of the rootfs packages -> dist/rootfs-sources.tar"
	@echo "make all           fetch + build + rootfs"
	@echo "make clean         remove blink/ and dist/"

all: fetch build rootfs

fetch:
	scripts/fetch-blink.sh

build:
	scripts/build-threads.sh

build-single:
	scripts/build-singlethread.sh

rootfs:
	PKGS="$(PKGS)" scripts/mkrootfs.sh

sources:
	scripts/fetch-sources.sh

serve:
	@echo ">> http://localhost:$(PORT)/  (the first load reloads once, for the COI service worker)"
	cd web && python3 -m http.server $(PORT)

clean:
	rm -rf blink dist

-include deploy/deploy.mk
