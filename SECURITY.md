# Security

Agentome runs inside companies, next to their code, their Jira and their keys, so a security
problem in it matters. Thank you for telling us first.

## Reporting a vulnerability

Write to **hello@agentome.ai** with the subject "Security", or use GitHub's private
vulnerability reporting on this repository. Please do not open a public issue.

Tell us what you found, the version (`AGENTOME_VERSION` or the image tag), how to reproduce it
and what an attacker gains. We answer within two working days, keep you posted while we fix it,
and credit you in the changelog if you wish.

## Supported versions

The latest release gets security fixes. Update with the same command that installed Agentome;
see [deploy/OPERATIONS.md](deploy/OPERATIONS.md).

## How Agentome is built to be safe

- Everything runs on your servers; nothing reports home, and the license is checked offline.
- An agent reaches your tools only through the server's MCP gateway, with a token that lives as
  long as its run. Tokens of GitLab, GitHub and Jira stay on the server: a computer never gets them.
- `git push` goes through the server's git proxy, only to the agent's own branches.
- Tool calls follow per-agent policies (allow, ask a person, deny); a call that asks waits for
  an approval.
- Secrets are encrypted at rest with a key the server keeps in its data directory.
