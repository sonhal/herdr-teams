#!/bin/sh
# Downloads the pinned herdr release used by the live tests and prints its path.
#   HERDR_BIN_PATH=$(sh scripts/fetch-herdr.sh) npm run test:live
set -eu

# Keep in sync with HERDR_VERSION in tests/live/harness.ts.
VERSION=0.9.5
SHA256=14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=herdr-linux-x86_64 ;;
  *)
    echo "no pinned herdr $VERSION build for $(uname -s)-$(uname -m); set HERDR_BIN_PATH" >&2
    exit 1
    ;;
esac

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="$ROOT/.cache/herdr/$VERSION"
BIN="$DIR/herdr"
mkdir -p "$DIR"

if [ ! -x "$BIN" ] || [ "$(sha256sum "$BIN" | cut -d' ' -f1)" != "$SHA256" ]; then
  curl -fsSL -o "$BIN.partial" \
    "https://github.com/herdrdev/herdr/releases/download/v$VERSION/$ASSET"
  if [ "$(sha256sum "$BIN.partial" | cut -d' ' -f1)" != "$SHA256" ]; then
    rm -f "$BIN.partial"
    echo "checksum mismatch for $ASSET (herdr $VERSION)" >&2
    exit 1
  fi
  chmod +x "$BIN.partial"
  mv "$BIN.partial" "$BIN"
fi

echo "$BIN"
