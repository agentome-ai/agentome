#!/bin/sh
# The server seat's start. Claude Code is not ours to hand out, so the image
# holds only the list of what to install: the pinned version and the checksum of each package,
# in /usr/local/lib/agentome/claude-code. A seat that takes runs installs from that list into
# memory, where the run's own files are, and keeps npm's cache in its volume. Every start
# checks each package against the image's checksums, so a run leaves no changed CLI for the
# next one, and after the first start the seat needs no registry.
set -eu

worker=/usr/local/lib/agentome/agentome-worker.mjs
# connect and status take no run: they need no CLI.
[ "${1:-run}" = run ] || exec node "$worker" "$@"

list=/usr/local/lib/agentome/claude-code
cli=/seat/cli
mkdir -p "$cli"
cp "$list/package.json" "$list/package-lock.json" "$cli/"
# The binary is an optional package of its platform: npm leaves out one whose checksum is wrong
# and still ends well, so the CLI is asked for its version before the seat takes a run with it.
if ! npm ci --prefix "$cli" --cache /seat/npm-cache --prefer-offline --no-audit --no-fund \
  --no-update-notifier --loglevel=error >&2 ||
  ! "$cli/node_modules/.bin/claude" --version >/dev/null 2>&1; then
  echo 'agentome: Claude Code could not be installed, so the seat takes no runs. It installs it from the npm registry at its first start and from its own cache after that. Give the seat a way to the registry, or a mirror in NPM_CONFIG_REGISTRY.' >&2
  exit 1
fi
# npm takes the binary for musl too, as large again, and this image is Debian's glibc.
rm -rf "$cli"/node_modules/@anthropic-ai/claude-code-*-musl
PATH="$cli/node_modules/.bin:$PATH"
export PATH
exec node "$worker" "$@"
