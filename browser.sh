#!/bin/bash
# Wrapper to run agent-browse with Node 22 (Stagehand incompatible with Node 25+)
NODE22="/opt/homebrew/opt/node@22/bin/node"
# Resolve through symlinks to find the real script directory
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
exec "$NODE22" "$SCRIPT_DIR/dist/src/cli.js" "$@"
