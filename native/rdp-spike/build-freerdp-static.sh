#!/usr/bin/env bash
# Build a minimal, statically-linked FreeRDP for bundling the RDP sidecar in a
# distributable app — no X11/Wayland, no ffmpeg/H.264, no server/shadow. This
# collapses the runtime dependency tree to just system libs + OpenSSL so the
# sidecar can ship without Homebrew on the target machine.
#
# Output: a prefix at native/rdp-spike/.freerdp-static/<arch> containing static
# libs + headers. The Makefile's `rdp-sidecar-static` target links against it.
#
# Usage: ./build-freerdp-static.sh [freerdp-tag]   (default: matches brew)
set -euo pipefail

FREERDP_TAG="${1:-3.27.0}"
ARCH="$(uname -m)"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/.freerdp-src"
PREFIX="$HERE/.freerdp-static/$ARCH"
OPENSSL_ROOT="$(brew --prefix openssl@3)"

echo ">> FreeRDP $FREERDP_TAG  arch=$ARCH  prefix=$PREFIX"

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$FREERDP_TAG" https://github.com/FreeRDP/FreeRDP.git "$SRC"
else
  cd "$SRC"
  git fetch origin
  git checkout "$FREERDP_TAG"
  cd "$HERE"
fi

cmake -S "$SRC" -B "$SRC/build-$ARCH" -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
  -DBUILD_SHARED_LIBS=OFF \
  -DWITH_X11=OFF -DWITH_WAYLAND=OFF \
  -DWITH_FFMPEG=OFF -DWITH_SWSCALE=OFF -DWITH_DSP_FFMPEG=OFF \
  -DWITH_SERVER=OFF -DWITH_SHADOW=OFF -DWITH_PROXY=OFF \
  -DWITH_CLIENT_SDL=OFF -DWITH_CLIENT_MAC=OFF -DWITH_SAMPLE=OFF \
  -DWITH_MANPAGES=OFF -DWITH_CUPS=OFF -DWITH_PCSC=OFF -DWITH_FUSE=OFF \
  -DWITH_KRB5=OFF -DWITH_LIBSYSTEMD=OFF -DWITH_OPENSSL=ON -DWITH_MBEDTLS=OFF \
  -DWITH_WINPR_TOOLS=OFF -DWITH_AAD=OFF \
  -DWITH_OPUS=OFF -DWITH_FAAD2=OFF -DWITH_FAAC=OFF -DWITH_SOXR=OFF -DWITH_GSM=OFF \
  -DWITH_WEBVIEW=OFF -DWITH_CJSON_REQUIRED=OFF \
  -DCHANNEL_URBDRC=OFF -DCHANNEL_REMDESK=OFF -DCHANNEL_RDPSND=OFF -DCHANNEL_AUDIN=OFF \
  -DCHANNEL_DRIVE=OFF -DCHANNEL_PARALLEL=OFF -DCHANNEL_SERIAL=OFF -DCHANNEL_PRINTER=OFF -DCHANNEL_SMARTCARD=OFF \
  -DOPENSSL_ROOT_DIR="$OPENSSL_ROOT" \
  -DOPENSSL_USE_STATIC_LIBS=ON

cmake --build "$SRC/build-$ARCH" --target install

echo ">> done: $PREFIX"
ls -1 "$PREFIX/lib"/*.a 2>/dev/null || echo "(warning: no static libs found)"
