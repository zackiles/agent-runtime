#!/bin/sh
set -e
TOOLS_DIR="${TOOLS_DIR:-$(dirname "$0")}"
OS="${TARGET_OS:-linux}"
ARCH="${TARGET_ARCH:-x64}"

VERSION=$(curl -fsSL https://cursor.com/install 2>/dev/null \
  | grep -o 'lab/[^/"]*' | head -1 | cut -d'/' -f2)

if [ -z "$VERSION" ]; then
  echo "Failed to detect cursor-agent version" >&2
  exit 1
fi

URL="https://downloads.cursor.com/lab/${VERSION}/${OS}/${ARCH}/agent-cli-package.tar.gz"
TEMP_DIR=$(mktemp -d)

curl -fsSL "$URL" -o "$TEMP_DIR/package.tar.gz"
tar xzf "$TEMP_DIR/package.tar.gz" -C "$TEMP_DIR"

PKG_DIR=$(find "$TEMP_DIR" -name "cursor-agent" -type f -exec dirname {} \; | head -1)
if [ -n "$PKG_DIR" ]; then
  cp -r "$PKG_DIR"/* "${TOOLS_DIR}/"
  mv "${TOOLS_DIR}/cursor-agent" "${TOOLS_DIR}/tool"
  chmod +x "${TOOLS_DIR}/tool"
  chmod +x "${TOOLS_DIR}/node" 2>/dev/null || true
fi

rm -rf "$TEMP_DIR"
[ -f "${TOOLS_DIR}/tool" ] || { echo "cursor-agent binary not found in package" >&2; exit 1; }
