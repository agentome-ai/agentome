# Claude Code stream-json fixtures

Output of `claude -p --output-format stream-json --verbose`, recorded or built by hand, and the
stand-in binary the launcher tests run against. The format is neither documented in full nor
versioned, so these files are the contract: the parser may change only in ways that keep them
parsing, and a CLI upgrade that breaks one of them is a signal, not a test to edit.

JSONL cannot carry a comment, which is why the provenance of every file is here.

| File                        | CLI     | Origin                                                                                                                                    | What it covers                                                                                                                                                                               |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-401.jsonl`            | 2.1.90  | **Recorded** on 2026-09-14 (an expired OAuth token), anonymised                                                                           | Ten `system/api_retry`, a `<synthetic>` message with zero usage and `error: authentication_failed`, and a result `{"subtype":"success","is_error":true}`                                     |
| `rate-limit-rejected.jsonl` | 2.1.270 | **Recorded** on 2026-09-19: the `rate_limit_event` line; the lines around it are synthetic                                                | A spent weekly limit: `rate_limit_event` with `status: "rejected"`, a synthetic answer, a failed result                                                                                      |
| `success-text.jsonl`        | 2.1.90  | Synthetic, in the recorded envelope                                                                                                       | `init` → a text answer with per-turn usage → the result; the numbers add up                                                                                                                  |
| `tool-use.jsonl`            | 2.1.90  | Synthetic                                                                                                                                 | `tool_use` → `tool_result` → the answer, with a `thinking` block that is dropped                                                                                                             |
| `garbage.jsonl`             | 2.1.90  | Synthetic                                                                                                                                 | Everything the parser must survive rather than read                                                                                                                                          |
| `resume-poisoned.jsonl`     | 2.1.90  | Synthetic                                                                                                                                 | The 400 a session with a poisoned `previous_message_id` gets, in the result and in `errors`                                                                                                  |
| `resume-model-text.jsonl`   | 2.1.90  | Synthetic                                                                                                                                 | `error_max_turns` whose result text is the model writing about sessions: it must not start a fresh session                                                                                   |
| `rate-limit-info.jsonl`     | 2.1.270 | Synthetic                                                                                                                                 | The same `rate_limit_event` as information (`allowed`), on a run that succeeds; the parser drops it                                                                                          |
| `gateway-cache-usage.jsonl` | 2.1.90  | Synthetic, derived from `success-text.jsonl`                                                                                              | A run through a LiteLLM gateway: the model `litellm_proxy/…`, usage without the `cache_creation` split, no `total_cost_usd`                                                                  |
| `housekeeping.jsonl`        | 2.1.280 | **Recorded** on 2026-10-21, anonymised; the commands list is invented, the rest synthetic                                                 | What the parser drops: `commands_changed`, `vcs_state_changed`, `thinking_tokens`, an `allowed` `rate_limit_event`; the answer around them is as usual                                       |
| `multi-block-usage.jsonl`   | 2.1.280 | **Recorded** on 2026-10-21, anonymised; `commands_changed` dropped                                                                        | Answers of several content blocks whose every line repeats the usage of the answer's start (1–2 output tokens), and a result with the true totals and `modelUsage`; cache writes for an hour |
| `org-not-allowed.jsonl`     | 2.1.280 | **Recorded** on 2026-10-21 (a Claude Code signed in to an organization that disables subscriptions), anonymised; the `init` line cut down | A `<synthetic>` message with `error: oauth_org_not_allowed`, and a failed result with `api_error_code: oauth_not_allowed_for_organization`                                                   |
| `fake-claude.mjs`           | —       | —                                                                                                                                         | The stand-in binary; its header lists the variables it takes                                                                                                                                 |

There are no `sdk-*` files: the Agent SDK is not used. The synthetic files are to be replaced by recordings of a live `claude` 2.1.x,
made by a person on their own machine: a live run under a subscription is never started by an
agent or by CI.

## Anonymisation

A recorded transcript keeps its structure and loses whatever identifies a person or a machine:
session ids and uuids are fixed values, `cwd` is `/tmp/agentome-probe` or `/tmp/agentome-run`, and
the lists of plugins, skills and commands are cut to generic entries. No file holds a token, a key
or a path from a home directory, and none may.
