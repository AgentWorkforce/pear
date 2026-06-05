#!/bin/sh
set -eu

launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
mcp_script="$launcher_dir/node_modules/agent-relay/dist/cli/agent-relay-mcp.js"

if [ ! -f "$mcp_script" ]; then
  echo "Agent Relay MCP script not found: $mcp_script" >&2
  exit 1
fi

electron_exe=""
macos_dir="$launcher_dir/../../MacOS"
linux_root="$launcher_dir/../.."

if [ -d "$macos_dir" ]; then
  for candidate in "$macos_dir"/*; do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      electron_exe=$candidate
      break
    fi
  done
else
  for candidate in "$linux_root"/*; do
    case "$(basename -- "$candidate")" in
      chrome-sandbox|*.so)
        continue
        ;;
    esac
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      electron_exe=$candidate
      break
    fi
  done
fi

if [ -z "$electron_exe" ]; then
  echo "Pear executable not found relative to launcher: $launcher_dir" >&2
  exit 1
fi

export ELECTRON_RUN_AS_NODE=1
exec "$electron_exe" "$mcp_script" "$@"
