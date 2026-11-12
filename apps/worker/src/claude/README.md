# Claude Code adapter

- `stream-json.ts` turns the output of `claude -p --output-format stream-json --verbose` into run
  events.
- `launcher.ts` starts `claude` for one run and supervises it (`runClaude`), and answers whether
  this computer can run it at all (`probe`).
- `fixtures/` holds the transcripts and the stand-in binary the tests run against; see its README.

Every run is isolated from the settings of the repository it works on: `--setting-sources user`
and `--strict-mcp-config` are always passed. The task's repository is untrusted data, and its
`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json` and hooks must never run on
the employee's computer. The agent's settings come only from its profile, as
`--settings <profileDir>/settings.json`, and its MCP servers only from the platform's
`--mcp-config`.

## To check on a live CLI

The tests run only against `fixtures/fake-claude.mjs`. What needs a real `claude` 2.1.x under a
subscription is listed once, for the whole worker, in [the worker's README](../../README.md#to-check-on-a-live-cli-task-9-the-owner).
