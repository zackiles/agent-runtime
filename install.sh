#!/bin/sh
set -e

REPO="zackiles/agent-runtime"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
VERSION="${1:-latest}"

os=$(uname -s)
case "$os" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *) printf "Unsupported OS: %s\n" "$os" >&2; exit 1 ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64)  arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) printf "Unsupported architecture: %s\n" "$arch" >&2; exit 1 ;;
esac

binary="ar-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${binary}"
else
  case "$VERSION" in v*) ;; *) VERSION="v${VERSION}" ;; esac
  url="https://github.com/${REPO}/releases/download/${VERSION}/${binary}"
fi

printf "Installing ar %s (%s-%s) to %s\n" "$VERSION" "$os" "$arch" "$INSTALL_DIR"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
else
  printf "Error: curl or wget is required\n" >&2
  exit 1
fi

chmod +x "$tmp"
mkdir -p "$INSTALL_DIR" 2>/dev/null || true

if [ -w "$INSTALL_DIR" ]; then
  mv "$tmp" "${INSTALL_DIR}/ar"
else
  sudo mv "$tmp" "${INSTALL_DIR}/ar"
fi

trap - EXIT

printf "Installed ar to %s/ar\n" "$INSTALL_DIR"
printf "Run 'ar help' to get started.\n"
