#!/bin/sh
set -e
TOOLS_DIR="${TOOLS_DIR:-$(dirname "$0")}"
OS="${TARGET_OS:-linux}"
ARCH="${TARGET_ARCH:-x64}"
case "$OS" in darwin) A0_OS="Darwin";; *) A0_OS="Linux";; esac
case "$ARCH" in x64) A0_ARCH="x86_64";; arm64) A0_ARCH="arm64";; *) A0_ARCH="x86_64";; esac
AUTH0_VERSION=$(curl -fsSL https://api.github.com/repos/auth0/auth0-cli/releases/latest | grep tag_name | cut -d'"' -f4 | sed 's/v//')
curl -fsSL "https://github.com/auth0/auth0-cli/releases/download/v${AUTH0_VERSION}/auth0-cli_${AUTH0_VERSION}_${A0_OS}_${A0_ARCH}.tar.gz" \
  | tar xz -C "${TOOLS_DIR}" auth0
mv "${TOOLS_DIR}/auth0" "${TOOLS_DIR}/tool"
