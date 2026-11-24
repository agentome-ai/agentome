#!/usr/bin/env bash
# Inside a seat image with no network, for scripts/check-claude-files.sh: a stand-in sign-in where a
# place keeps the person's, a working folder with links into it, the deny rules a place run gets
# (apps/worker/src/workspace.ts, profileSettings), and Claude Code against the mock API. The home
# folder is given to the CLI as a folder of the run's: then only the deny rules stand in the way,
# not the CLI's own rule against folders outside the run's, which a place could not count on.
set -euo pipefail
claude=/seat/cli/node_modules/.bin/claude
"$claude" --version
mkdir -p /home/node/.claude
sign_in=/home/node/.claude/.credentials.json
echo '{"claudeAiOauth":{"accessToken":"CANARY-sign-in"}}' > "$sign_in"
cp "$sign_in" /tmp/sign-in.before
cat > /tmp/settings.json <<'JSON'
{"permissions":{"deny":["Skill","Read(//proc)","Read(//proc/**)","Read(//sys)","Read(//sys/**)",
  "Read(//home/node)","Read(//home/node/**)","Edit(//home/node/**)",
  "Read(//tmp/agentome)","Read(//tmp/agentome/**)","Edit(//tmp/agentome/**)"]}}
JSON
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=sk-ant-check \
  CLAUDE_CONFIG_DIR=/tmp/claude-config DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# One pass of Claude Code over STEPS ($2) in /work, its stream-json into /out/$1.jsonl.
pass() {
  STEPS=$2 node /check/mock.mjs &
  local mock=$!
  sleep 1
  (cd /work && echo 'Do the steps.' | timeout 900 "$claude" -p --output-format stream-json --verbose \
    --setting-sources '' --permission-mode acceptEdits --settings /tmp/settings.json --add-dir /home/node \
    > "/out/$1.jsonl" 2> "/out/$1.err") || true
  kill "$mock"
}

steps() { node -e "$1"; }

# Links that lead to the sign-in, by every road a path has.
mkdir -p /work && cd /work
ln -s "$sign_in" link
ln -s /home/node/.claude folder
pass links "$(steps 'console.log(JSON.stringify([
  ["Read", { file_path: "/work/link" }],
  ["Read", { file_path: "/work/folder/.credentials.json" }],
  ["Write", { file_path: "/work/folder/written", content: "x" }],
  ["Edit", { file_path: "/work/link", old_string: "CANARY", new_string: "x" }],
  ["Read", { file_path: "/home/node/.claude/.credentials.json" }],
  ["Read", { file_path: "/work/../home/node/.claude/.credentials.json" }],
  ["Read", { file_path: "/proc/self/root/home/node/.claude/.credentials.json" }],
  ["Grep", { pattern: "CANARY", path: "/work", output_mode: "content" }],
  ["Glob", { pattern: "**/*", path: "/work/folder" }],
]))')"

# The agent's side of a race: a file that turns into a link to the sign-in and back, as fast as a
# command can, while the file tools read it, then write it.
echo plain > race
( while :; do echo plain > race.f; mv -f race.f race; ln -sfn "$sign_in" race.l; mv -f race.l race; done ) &
racer=$!
pass reads "$(steps 'console.log(JSON.stringify(Array.from({ length: 150 }, () => ["Read", { file_path: "/work/race" }])))')"
pass writes "$(steps 'console.log(JSON.stringify(Array.from({ length: 75 }, () => [["Read", { file_path: "/work/race" }], ["Write", { file_path: "/work/race", content: "WRITTEN" }]]).flat()))')"
kill "$racer"

node /check/judge.mjs /out "$sign_in" /tmp/sign-in.before
