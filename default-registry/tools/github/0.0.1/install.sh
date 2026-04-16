#!/bin/sh
set -e
TOOLS_DIR="${TOOLS_DIR:-$(dirname "$0")}"
OS="${TARGET_OS:-linux}"
ARCH="${TARGET_ARCH:-x64}"
case "$ARCH" in x64) GH_ARCH="amd64";; arm64) GH_ARCH="arm64";; *) GH_ARCH="amd64";; esac
case "$OS" in darwin) GH_OS="macOS";; *) GH_OS="linux";; esac
GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep tag_name | cut -d'"' -f4 | sed 's/v//')
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${GH_OS}_${GH_ARCH}.tar.gz" \
  | tar xz --strip-components=2 -C "${TOOLS_DIR}" "gh_${GH_VERSION}_${GH_OS}_${GH_ARCH}/bin/gh"
mv "${TOOLS_DIR}/gh" "${TOOLS_DIR}/tool"
