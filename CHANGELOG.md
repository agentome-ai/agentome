# Changelog

What changed in each release of Agentome. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The site, the README and the guide link the npm package, the MCP Registry record and the n8n node, and show `npx agentome install` as a second way to install.
- New team can start from the Development team template: it creates a Development lead, a new role template, with Backend developer, Frontend developer, Code reviewer and QA engineer, in three steps: build, review and test. The five agents fit Free.

### Changed

- A team's members can be put in another order on its page, from a member's menu or by dragging; the chart and the lists show that order. The project and team pages are as wide as the rest of the app.

## [0.3.0] - 2026-11-16

A run on your server now keeps the person's subscription apart from the agent's commands. Each run
in a place is two containers: the CLI container, with the official Claude Code or Codex and the
person's sign-in, and the sandbox, where every command the agent runs goes. Places and runs get a
kernel of their own under gVisor, a run may have a Docker of its own for its tests, and an agent's
push reaches its branch only after a check. The guide has new pages for deploying on your server
and for security.

### Added

- A CLI container and a sandbox for each run in a place. The CLI's `bash` and `git` pass every
  command to the sandbox, which has the task's repository and nothing of the sign-in. The CLI goes
  out to the model vendors under a token of its own; commands reach only Agentome and the hosts the
  project allows.
- gVisor for places and runs: `AGENTOME_PLACE_RUNTIME=runsc` on Docker, or a RuntimeClass on
  Kubernetes, where a run is one pod with both containers and the project's services.
- A Docker of a run's own, for testcontainers and compose stacks: with
  `AGENTOME_PLACE_DOCKER_RUNTIME`, a dockerd inside gVisor beside the sandbox, pulling through the
  egress proxy and deleted with the run.
- A project's **Network** section: the hosts its runs may reach, the hosts the proxy refused them
  in the last week with **Allow** beside each, and **Add public package registries**.
- `agentome rotate-key`, which seals every secret the database keeps under a new key, for one that
  may have leaked, and keeps the installation's id for its license.
- A docker guard in front of Docker's socket: the place launcher no longer holds the socket or runs
  as root, and the guard passes only the calls that make places and runs.
- `AGENTOME_COMPUTERS=false`, for agents on the server only, with no person's computer connected.
- Two-step sign-in with an authenticator app, without Keycloak, required of every admin; with
  Keycloak, password sign-in can be turned off.
- `agentome`, one program on npm: `npx agentome install` sets up the server with Docker Compose,
  and `agentome mcp` connects an MCP client to the server's management tools.
- The API is documented at `/openapi.json` and in the guide's reference.
- The guide's **Deploy on your server** and **Security** pages.

### Changed

- An agent's push lands first on a ref of the git proxy's own, on which no pipeline runs, and moves
  its branch only when it keeps the branch's history and leaves the CI configuration as the default
  branch has it: on GitLab the CI file and every file it includes, child pipelines too; on GitHub
  the `.github` folder and the local actions its workflows use.
- The egress proxy reads the server name of each tunnel and lets through port 443 only, unless a
  host is listed with another; it connects only to the address it checked.
- Places on Docker each have a network of their own, and a backup holds the database without the
  secret key.

### Fixed

- A place clones its task's repository where the server has an HTTPS address.
- A run in a place under gVisor starts at once, not after up to a minute.
- A place takes runs again after Claude Code's token expired and a sign-in check left its lock.
- The server seat reaches the internet only through the egress proxy.
- A task's repository gets credentials only when its project lists it, and a computer runs only
  what points at the server it was connected to.
- The API has a rate limit, and the images are signed.

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
