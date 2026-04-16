#!/bin/sh
set -e
TOOLS_DIR="${TOOLS_DIR:-$(dirname "$0")}"
OS="${TARGET_OS:-linux}"
ARCH="${TARGET_ARCH:-x64}"
curl -fsSL "https://github.com/DataDog/datadog-ci/releases/latest/download/datadog-ci_${OS}-${ARCH}" \
  --output "${TOOLS_DIR}/tool"
chmod +x "${TOOLS_DIR}/tool"
