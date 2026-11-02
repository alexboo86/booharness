#!/bin/sh
# macOS/Linux per-user install. Pairing JSON is read from stdin, never argv.
set -eu
if [ "$#" -ne 1 ] && { [ "$#" -ne 3 ] || [ "$2" != "--home" ] || [ -z "$3" ]; }; then
  echo "usage: $0 <agent-bundle.tar> [--home <dir>] < pairing.json" >&2
  exit 2
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=${NODE_BIN:-node}
BUNDLE=$1
shift
"$NODE_BIN" "$SCRIPT_DIR/cli.mjs" install --bundle "$BUNDLE" "$@"
