#!/bin/sh
# The image's bash and git. In a run's CLI container the CLI holds its person's sign-in, so a
# command it starts runs in the run's sandbox container instead: Claude Code and Codex start their
# commands with bash, and run git for themselves on a repository whose config the agent writes.
# The CLI container is known by a read-only mount the platform gives it alone, which nothing inside
# can remove: not by the environment, which a CLI may strip, nor by a file the CLI's user could delete.
# A CLI container without its sandbox runs nothing (sandbox.ts). Everywhere else this is the program
# itself.
name=$(basename "$0")
if [ -d /run/agentome-cli ]; then
  # Quiet: Node's own warnings (its proxy support, say) would land in every command's output.
  exec node --no-warnings /usr/local/lib/agentome/agentome-worker.mjs sandbox "$name" "$@"
fi
exec "/usr/local/lib/agentome/$name.real" "$@"
