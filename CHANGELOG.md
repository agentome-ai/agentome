# Changelog

What changed in each release of Agentome. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-13

Agents now run in containers on your server. Each person gets a place of their own, where their
agents work under their own Claude or ChatGPT subscription while they are at work in Agentome, in a
closed network, beside the services their project needs. Installing a worker on people's computers
becomes an option for small teams. This release also closes the findings of an external security
review.

### Added

- People's places on the server. A person makes their place in Computers: a container the platform
  makes for them, with no capabilities and a read-only root. They sign in once to Claude Code or
  Codex in a terminal in the browser, and their agents run in it only while they have Agentome open
  and in use. A place sleeps when nothing runs and wakes for the next task, keeping its sign-in.
  Turned on with the `places` profile of `compose.yaml`, or the `places` component of
  `deploy/kubernetes`, where a place is a pod with two volume claims.
- Working folders that stay. In a place, an agent keeps one folder per repository between runs,
  with its dependencies and builds; what a run left uncommitted is saved to a branch first.
- The common toolchains in the place's image: Python 3.11, Java 21 with Maven, Go 1.27, .NET 8,
  gcc and Node 22.
- Services from the repository's devcontainer. Agentome reads the services a project's main
  repository lists in `.devcontainer` (a database, a queue), an admin approves the list, and a
  person's place runs them beside the agent, by their names. Only images run as they are: nothing
  built, privileged or mounting the host.
- A closed network for places. A place reaches only Agentome, the model's vendor and the hosts an
  admin allows on a project, through an egress proxy; everything else is refused.
- Place events in Admin → Logs: a place made, woken, put to sleep and deleted, its terminal
  opened and closed, its services started, and every host its proxy let out or refused, under the
  run or the place.
- The model key stays on the server. An agent that works by itself on the server seat calls its
  model through the server, with the run's own token; the key never reaches the seat.

### Changed

- An agent's **Where it works** reads **With its owner** (in their place or on their computer)
  and **By itself** (on the server seat, with an API key).
- Defaults that ask more: replying on a change request asks the owner first, as opening one and
  commenting in Jira do. An imported agent starts with the default tool policies, whatever its
  file says, and the import shows its instructions.
- `AGENTOME_TRUST_PROXY=true` trusts the one proxy in front, not any `X-Forwarded-For`; a number
  trusts that many. With the HTTPS proxy, plain HTTP answers the server's own machine only. The
  install script gives a new installation a random database password.

### Fixed

- Security. Every page carries a Content Security Policy, `nosniff`, a refusal to be framed and,
  over HTTPS, HSTS. A saved token, model key or MCP header goes only to the address it was entered
  for, and routes that take or show a secret work in the browser only, never with an API token.
  Approvals show the call's arguments whole, as sent, with every web address in them listed, and
  no key approves. Text from Jira issues and change requests reaches an agent as marked data, not
  as its task. On a computer, the person's home folder is closed to the agent but for its
  workspace and toolchains, and Claude Code loads none of the person's own settings into a run.
- The server seat runs without capabilities and with limits.
- Windows: git is called by its full path.

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
