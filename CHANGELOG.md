# Changelog

What changed in each release of Agentome. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.4] - 2026-11-26

A skill can bring its files, the Library becomes two pages, and runs have no limits unless you
set them. The update adds one table to the database; it applies itself on start.

### Added

- A skill brings its files: scripts, templates and references beside its SKILL.md. **Upload a skill folder** on Skills, or `files` in `POST /api/library/skills` and in a new version (up to 3,000 files, 25 MB in all, 5 MB a file); a version without files keeps the previous one's. A run gets them read only beside the skill. An exported agent says its skills' files stay behind.
- Guide, Integrations: a Jira Cloud administrator agent with the open-source `jira-cloud-admin-mcp` server.

### Changed

- **Skills** and **MCP servers** are two pages in the sidebar and in ⌘K instead of the Library; old `/library` links lead to the page they name. An item's facts and the agents that use it stand in one line under its name. A server's tools are a line each, opening to the whole description, with a filter past eight.
- Run limits are off by default. `AGENTOME_RUN_MAX_MINUTES`, `AGENTOME_RUN_MAX_TURNS` and `AGENTOME_RUN_MAX_TOKENS` have no default, and an agent's Budget shows **No limit** where neither sets one; set, they work as before. Workers of earlier versions run such runs unchanged.
- The token limit no longer counts cache reads, for Claude Code and Codex: on a long run they were nearly all of the count.

### Fixed

- An MCP server with OAuth sign-in is added only when it says how to sign in to it; one that publishes no OAuth metadata is refused with that reason instead of staying in the list unusable.

## [0.4.3] - 2026-11-24

Tasks can be deleted, alone or several at once, and a place on the server checks its Claude Code
before a run. The update adds one column to the database; it applies itself on start.

### Added

- Delete a task from its page. It leaves the lists and takes no more runs; its runs and what they cost stay in the history and the budgets. A task from Jira does not come back when its issue changes. A task whose run is queued or going is not deleted: cancel the run first. Also `DELETE /api/tasks/:id` and `delete_task` in the management MCP server.
- Change or delete several tasks at once: on Tasks, select tasks with the boxes before them (or X on a row), then Mark as done, Move to review, Reopen or Delete. A task that cannot be changed stays selected, with the reason.

### Changed

- The task, project and team pages show Delete task, Delete project and Delete team as a button instead of in a menu of one item.

### Security

- A place on the server runs no Claude Code older than 2.1.280; such a run fails with `sandbox_unavailable` before it starts. That version and later were checked against links to the sign-in and file swaps racing a read or a write, with the place's own deny rules, and the check is part of the image's build checks.

## [0.4.2] - 2026-11-23

A fix release: since 0.4.0 a new place on the server could not start. **Update before you make
places**; places made before 0.4.0 were not affected. On Kubernetes, apply both
`deploy/kubernetes` and `deploy/kubernetes/places` (OPERATIONS, Updating on Kubernetes).

### Fixed

- A new place on the server connects to the server again. Since 0.4.0 the launcher gave it the app's address inside the installation, which the place refused as plain HTTP across a network, so making a place failed, with compose and on Kubernetes. Places connected before 0.4.0 kept working.
- A request's log lines no longer carry the fields of its earlier lines: a refused host's egress line showed the list entry and the bytes of the connection logged before it.

### Changed

- OPERATIONS, Updating on Kubernetes: take the release's manifests and apply the places' too, then wait for both rollouts; before, the section changed the app's tag alone and left the places' launcher, proxy, policies and roles on the old release. The image check names `<version>` instead of an old release.

## [0.4.1] - 2026-11-23

A security release: the fourth review's fixes that need no change in how you run Agentome. Every
connection a place makes through the egress proxy is now in the log, releases are signed and
scanned before they go out, and the docker guard, the egress proxy, the profile an agent reads and
the approval of new instructions hold harder. **On Kubernetes, apply `deploy/kubernetes/places`
with this release**: the launcher's new rights come with it.

### Security

- The egress proxy logs every connection it lets out, as it ends, with the entry of the project's list that let it out, the bytes each way and how long it lasted, and for plain HTTP the method, the path and the status; every refusal says why. Before, a host it let out was logged once a minute. HTTPS stays a host: the proxy does not decrypt TLS.
- Each release's images carry their build provenance and a software bill of materials, the npm package names the workflow run that published it, and the GitHub Release has `install.sh` and `compose.yaml` with signed `SHA256SUMS`. A release goes out only when gitleaks finds no secret in the tree and trivy finds no critical vulnerability with a fix in either image. How to check each is in OPERATIONS, Checking an image.
- The docker guard passes an image pull only by the image's name and tag, never an import from an address that could take the name of Agentome's own image. A container must name the places' runtime unless the installation chose `runc`, may carry only the security options a launcher sets, and runs as the place's user or its image's own.
- Approving an agent's proposal to rewrite its own instructions takes the browser: a personal token, such as the management MCP's, may deny one but not approve it. The self-review task marks what others wrote in it (task titles, run reasons, past reports, comments) as data, as the gateway does.
- No `@` in the profile's CLAUDE.md outside code can be read by Claude Code as an import, wherever it comes from (a task's thread, a past report, a skill's description) and whatever markdown is around it: one that is not part of an address becomes a full-width `＠`.
- A Codex agent in a place gives its commands the sandbox's environment only, never its own container's way out and its token.
- A host allowed from the refusals in a project's Network section reaches public addresses only (the list shows it as public only): a run chose its name, and its owner may point it at the company's network. A host an admin adds by its name keeps reaching the company's network. The egress proxy never reaches Google Cloud's metadata over IPv6 or AWS's pod identity agent, whatever name leads there.
- One event of the egress proxy the app cannot read (a host name with `_`) no longer drops the whole report with other runs' lines; the proxy also refuses such a name before it counts it.
- undici, through which the server reaches MCP servers, is 6.29.1, with the fixes for a server that crashes the process with a certificate it changes mid-connection. A run's own Docker is Docker 29.9.3.
- The git proxy's CI check follows an action in `.github` to one it uses outside it, and refuses a GitLab child pipeline made from a job's artifact or an include of the same project by its address. A `*.` host may no longer cover atlassian.net, ngrok.app, cloudfunctions.net, nip.io and similar shared domains. The MCP library reaches no cloud's metadata service, as the egress proxy does not. Proposed instructions with invisible characters or ones that turn text around are refused. The worker keeps no unread output of a Codex executor and closes a run server's connection on a line without end. The egress proxy counts a refused token asked again against its limit.
- On Kubernetes, a run's pod takes a connection only from its own place: before, any place reached any run's CLI container, with only the run's key between them. The places' namespace denies every connection no policy allows, the launcher checks that the RuntimeClass it is given runs gVisor, and the quota counts CPU and memory. **Apply `deploy/kubernetes/places` with this release**: the launcher's new rights (a run's NetworkPolicy, reading a RuntimeClass) come with it.

## [0.4.0] - 2026-11-22

A person's place on the server may now work while they are away, when they choose so in the
browser and an admin allows it. An agent can review its own last month and propose better
instructions, which land only on its owner's approval. Codex agents run in people's places again,
every command on Codex's own executor in the sandbox. The third security review is closed: places
on Kubernetes move to a namespace of their own, and the egress proxy, the model relay, the docker
guard and the git proxy's CI check hold harder. **Read the update notes in Security before you
update a server with places.**

### Security

- **On Kubernetes**, places, their launcher and their egress proxy move to a namespace of their own, `agentome-places`, where the launcher can no longer reach the app's database or its secret; Pod Security there refuses privileged and host pods. The launcher gets a key of its own instead of the installation's, and the server takes the client's address from the ingress controller only. **When you update** with places: apply `deploy/kubernetes/places` on its own, give the places their keys with `agentome places-key` and `agentome egress-key`, and point `AGENTOME_PLACE_LAUNCHER_URL` at the launcher (see the deploy guide); places made before are made anew, and people sign in to their CLIs again.
- Places run under gVisor unless an admin chooses the host's kernel with `AGENTOME_PLACE_RUNTIME=runc`; the launcher checks that the runtime it is given really is gVisor's, and a run's own Docker is checked the same way. **When you update** a server with places and no `AGENTOME_PLACE_RUNTIME` in `.env`, set it to `runsc`, or to `runc`, before people's agents run again.
- A project's services beside a place on Docker, such as its database, run under the places' runtime too; before, on a server with gVisor they ran on the host's kernel. A service made under another runtime is made anew when its place next gets its project's services; its volume stays.
- The places' egress proxy proves itself to the server with a key of its own, so a run cannot write into a project's Network section or ask about tokens, and one run's flood of bad tokens no longer cuts every place off. Cloud metadata addresses are refused under any name. Allowing a refused host now shows its whole name and asks first. The proxy's log counts a run's reached and refused hosts apart, so a flood of refused names cannot hide where a run got through.
- A run's own Docker is on a network of its own with the run's sandbox and the egress proxy alone, no longer on the place's network, where the place's worker talks to the server.
- The docker guard checks each call's body field by field against the fields a launcher sends, and passes Docker its own writing of it; a container it acts on must be a place's. The server itself now deletes the containers of a place's run it closed, so a worker that died no longer leaves the CLI container with the person's sign-in behind.
- The model relay for server runs on an API key keeps its limits before it reads a call, stops a run's calls once its agent's or project's month is spent, and counts the calls a run hangs up on and those of runs the server closed, so they show in costs.
- Codex agents run in people's places again: every command, edit and image read of Codex runs in the run's sandbox, on Codex's own executor, never beside the person's ChatGPT sign-in. Before each Codex run the worker checks, without a subscription, that a command really lands in the sandbox, and fails the run otherwise.
- A person's place keeps only their sign-in in `~/.claude` and `~/.codex`, before and after each run of their agents: settings, MCP servers and hooks there are taken out, so nothing a run writes there runs with the sign-in.
- In a person's place on the server, an agent's commands can no longer end up beside the person's sign-in: the CLI's container is marked so that nothing inside can unmark it, the CLI's file tools are kept out of its home folder, and a repository's CLAUDE.md can import only its own files.
- The git proxy's CI check closes three gaps: a GitLab `include` or component that names its project with a variable, a project whose CI file path the token cannot see, and a GitHub local action outside `.github`, now compared as its whole folder.
- A project's Network section refuses a star over a domain strangers share, such as `*.co.uk`, `*.amazonaws.com` or `*.github.io`: name the host in full. A repository's devcontainer and compose files are read up to 256 KB each, and `agentome mcp` takes `http://` only on this machine.

### Added

- **Work while I'm away**, in a person's place on the server: off until they turn it on in the browser, after a warning that a personal plan's terms may not allow use with nobody at it. An admin turns it off for everyone in Admin, Computers, with **Let people's places work while they are away**, on by default.
- An agent reviews its own work: **Start a review** in Quality, on the agent's page, gives the agent a task written from its last 30 days, the tasks that came back most and what people wrote. It writes its lessons into its memory and may propose new instructions with the new gateway tool `agent_propose_instructions`, which always asks its owner; Approvals shows the proposal as a diff. The management MCP has `start_agent_review`.
- A run started by a failed pipeline is told what to do with a failure outside its change, such as a runner or a missing secret: not to fix it, and to tell its owner which job failed and what a person must do.
- **Edit connection** in a connection's menu changes where it reaches: GitHub's owner, a GitLab address and group, or a Jira address, project key, filter and statuses. The project, the agent and the token stay.
- New team can start from the Development team template: it creates a Development lead, a new role template, with Backend developer, Frontend developer, Code reviewer and QA engineer, in three steps: build, review and test. The five agents fit Free.
- Each agent in the site's catalog has its own page with its instructions and every skill in full, so you can read what you import before you download it.
- The site, the README and the guide link the npm package, the MCP Registry record and the n8n node, and show `npx agentome install` as a second way to install.

### Changed

- A team's members can be put in another order on its page, from a member's menu or by dragging; the chart and the lists show that order. The project and team pages are as wide as the rest of the app.
- Places know the app as `agentome.internal`: an installation whose address ends in `.app` was reached around the egress proxy, where nothing answers, so a project's `.app` hosts failed and Codex lost the gateway's tools. An awake place is made anew once after the update.
- Compose names the places' network by its project, `agentome_places`, so two installations on one host stay apart.
- A place's image has `ripgrep` and `ps`, which Codex needs to search code and to start interactively.
- **Create token** is enabled before a name is typed, and says so when the name is missing.
- Admin and License stand in the same column as Admin's other pages.

### Fixed

- The terminal of a person's place on Docker opens again.
- A Codex run in a place without a repository starts again.
- The places' egress proxy starts on an update or a fresh install: compose waits for the app, which writes the proxy's key.
- Deleting a person's place on Docker removes its networks as well; before, each deleted place left one behind, and a server with many places could run out of Docker's networks.
- A new place whose pairing fails leaves no volumes or network behind.
- A kept folder's `.git/config` is written anew, never through a link the last run left.

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

[Unreleased]: https://github.com/agentome-ai/agentome/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/agentome-ai/agentome/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/agentome-ai/agentome/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/agentome-ai/agentome/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/agentome-ai/agentome/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/agentome-ai/agentome/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/agentome-ai/agentome/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/agentome-ai/agentome/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/agentome-ai/agentome/releases/tag/v0.1.0
