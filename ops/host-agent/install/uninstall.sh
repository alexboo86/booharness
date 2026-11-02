#!/bin/sh
set -eu
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != "--home" ] || [ -z "$2" ]; }; then
  echo "usage: $0 [--home <dir>]" >&2
  exit 2
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=${NODE_BIN:-node}
"$NODE_BIN" "$SCRIPT_DIR/cli.mjs" uninstall "$@"
