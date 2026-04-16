#!/bin/sh
set -e
TOOLS_DIR="${TOOLS_DIR:-$(dirname "$0")}"
OS="${TARGET_OS:-linux}"
ARCH="${TARGET_ARCH:-x64}"
curl -fsSL "https://storage.googleapis.com/anthropic-sdk/claude-cli/latest/claude-${OS}-${ARCH}" \
  -o "${TOOLS_DIR}/tool" && chmod +x "${TOOLS_DIR}/tool"
