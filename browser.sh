#!/bin/bash
# Wrapper to run agent-browse with Node 22 (Stagehand incompatible with Node 25+)

resolve_node22() {
  if [ -n "${NODE22:-}" ] && [ -x "${NODE22}" ]; then
    printf '%s\n' "${NODE22}"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    local active_node
    active_node="$(command -v node)"
    if [ "$("${active_node}" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = "22" ]; then
      printf '%s\n' "${active_node}"
      return 0
    fi
  fi

  local candidate
  for candidate in \
    "${HOME}/.nvm/versions/node"/v22*/bin/node \
    "/opt/homebrew/opt/node@22/bin/node" \
    "/usr/local/opt/node@22/bin/node"
  do
    if [ -x "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

NODE22="$(resolve_node22)" || {
  echo "agent-browse requires Node 22, but no compatible node binary was found." >&2
  exit 1
}

# Resolve through symlinks to find the real script directory
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "${REPO_ROOT}/config/api_keys.json" ]; then
  ANTHROPIC_API_KEY="$("${NODE22}" -e '
    const fs = require("fs");
    const path = process.argv[1];
    try {
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      process.stdout.write(data?.anthropic?.api_key || "");
    } catch (_) {}
  ' "${REPO_ROOT}/config/api_keys.json")"
  if [ -n "${ANTHROPIC_API_KEY}" ]; then
    export ANTHROPIC_API_KEY
  fi
fi

exec "$NODE22" "$SCRIPT_DIR/dist/src/cli.js" "$@"
