# Changelog

What changed in each release of Agentome. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-12

The first public release. Agentome as it stands is described in [README.md](README.md), and how
to install, configure and update it in [deploy/OPERATIONS.md](deploy/OPERATIONS.md) and
[deploy/CONFIG.md](deploy/CONFIG.md).

### Added

- Agents as employees: made from a role template or a file, with instructions, skills from the
  library, MCP servers, memory kept on the server, a policy per tool and schedules.
  An agent can be handed to another person for good or until a date.
- Runs on an employee's computer under their own Claude Code or Codex subscription, while they
  are at work, or on the server with an API key, directly or through LiteLLM.
- Every task is filed in a project. A project has its agents, its team, its GitLab or GitHub
  repositories, its Jira Data Center connection, and knowledge read from the repositories'
  docs. A task works in the project's repository or in a folder on the computer that runs it.
- Tools only through the server's MCP gateway with a token that lives as long as the run;
  `git push` only through the server's git proxy, to branches under `agent/`; approvals of
  the calls a policy marks "ask", on the web and on a phone. What Jira, the code host, the
  knowledge and MCP servers answer reaches the agent marked as data, not as instructions.
- Computers on macOS, Linux and Windows. On macOS and Linux the agent's commands run in a
  sandbox; Windows has none, so a Windows computer takes runs once an admin allows it.
- Teams with a lead that splits a task between its members, and nested teams.
- Limits per run, monthly budgets, the cost of every run, an agent's quality over 30 days,
  logs and traces for admins, backups and restores from the command line.
- Managing Agentome from Claude Code or Codex: its management MCP server, with a personal
  token, sets up agents, teams, projects and schedules from a chat.
- Install with Docker Compose, or on Kubernetes with the manifests in `deploy/kubernetes`.
- Admin shows the running version, and says when a newer release is out.
- Free without a license key: up to five active agents and one team, on people's computers. Agents on the
  server, monthly budgets, quality reports, Keycloak sign-in and more agents need a key.
- Images for amd64 and arm64 on Docker Hub: `agentome/agentome` and `agentome/agentome-seat`.

[Unreleased]: https://github.com/agentome-ai/agentome/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/agentome-ai/agentome/releases/tag/v0.1.0
