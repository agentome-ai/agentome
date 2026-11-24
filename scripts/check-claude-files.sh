#!/usr/bin/env bash
# Do Claude Code's file tools keep a place's agent from the person's sign-in? In a place they work
# in the run's CLI container, beside ~/.claude, kept from it by the deny rules alone, and a command
# in the sandbox can make a file in the working folder a link to it. This installs the Claude Code
# the seat image pins, as a seat does, and runs it with no network against a stand-in for the
# Messages API that asks for the tool calls an agent would try: through links, by `..` and
# /proc, and racing a file that turns into a link while it is read and written. No model and no
# sign-in of anyone's take part. Run it when the pinned version changes (Dockerfile,
# CLAUDE_CODE_VERSION); local CI's docker job runs it on every pull request.
#
#   scripts/check-claude-files.sh                    # builds the seat image from this checkout
#   scripts/check-claude-files.sh agentome-seat:x    # or checks one that is built
set -euo pipefail
cd "$(dirname "$0")/.."
image=${1:-agentome-seat:claude-check}
[ $# -ge 1 ] || docker build -q --target seat -t "$image" . >/dev/null
volume=agentome-claude-check-$$
out=$(mktemp -d)
trap 'docker volume rm -f "$volume" >/dev/null; rm -rf "$out"' EXIT
# As seat-start.sh: the image's list, its checksums, from the registry. The volume on /seat takes
# that folder's owner, the seat's user.
docker run --rm -u 1000 -v "$volume:/seat" --entrypoint sh "$image" -c \
  'mkdir -p /seat/cli && cp /usr/local/lib/agentome/claude-code/package*.json /seat/cli/ &&
   npm ci --prefix /seat/cli --cache /tmp/npm --no-audit --no-fund --no-update-notifier --loglevel=error'
docker run --rm -u 1000 --network none -e HOME=/home/node \
  --tmpfs /home/node:uid=1000,gid=1000 --tmpfs /tmp:uid=1000,gid=1000 \
  --tmpfs /work:uid=1000,gid=1000 --tmpfs /out:uid=1000,gid=1000 \
  -v "$volume:/seat:ro" -v "$PWD/scripts/claude-files:/check:ro" \
  --entrypoint bash "$image" /check/check.sh
