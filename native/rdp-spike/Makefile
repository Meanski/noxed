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

# Production sidecar: statically linked against the minimal FreeRDP built by
# build-freerdp-static.sh, so it ships with no Homebrew/dylib dependencies.
# Outputs to `rdp-sidecar` (same path the app + extraResources expect). Run the
# build script first: ./build-freerdp-static.sh
ARCH        := $(shell uname -m)
STATIC      := .freerdp-static/$(ARCH)
OPENSSL     := $(shell brew --prefix openssl@3)
JANSSON     := $(shell brew --prefix jansson)
STATIC_LIBS := $(STATIC)/lib/libfreerdp-client3.a $(STATIC)/lib/libfreerdp3.a $(STATIC)/lib/libwinpr3.a \
               $(OPENSSL)/lib/libssl.a $(OPENSSL)/lib/libcrypto.a \
               $(JANSSON)/lib/libjansson.a

rdp-sidecar-static: sidecar.c
	$(CC) -Wall -Wextra -O2 \
	  -I$(STATIC)/include/freerdp3 -I$(STATIC)/include/winpr3 \
	  -o rdp-sidecar sidecar.c \
	  $(STATIC_LIBS) -lz -lobjc \
	  -framework CoreFoundation -framework Foundation -framework CoreServices \
	  -framework Security -framework IOKit

clean:
	rm -f rdp-spike rdp-sidecar *.ppm

.PHONY: clean rdp-sidecar-static
