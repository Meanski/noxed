# Spike build. FreeRDP 3 + WinPR 3 via pkg-config (brew install freerdp).
# On Apple Silicon brew, the .pc files live under /opt/homebrew/lib/pkgconfig.

PKG_CONFIG_PATH := $(shell brew --prefix)/lib/pkgconfig:$(PKG_CONFIG_PATH)
export PKG_CONFIG_PATH

PKGS    := freerdp-client3 freerdp3 winpr3
CFLAGS  := -Wall -Wextra -O2 $(shell pkg-config --cflags $(PKGS))
LDFLAGS := $(shell pkg-config --libs $(PKGS))

all: rdp-spike rdp-sidecar

rdp-spike: spike.c
	$(CC) $(CFLAGS) -o $@ spike.c $(LDFLAGS)

rdp-sidecar: sidecar.c
	$(CC) $(CFLAGS) -o $@ sidecar.c $(LDFLAGS)

clean:
	rm -f rdp-spike rdp-sidecar *.ppm

.PHONY: clean
