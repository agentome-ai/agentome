# Security

This page is for whoever answers for the company's security: what an agent can reach, where each
secret lives, and what Agentome does not protect. It describes an installation on the company's
server with places under gVisor, as on [Deploy on your server](deploy.md); a person's computer
gets less, as the last section says.

## An agent is a program that runs commands

An agent reads tasks, issues, code and documents that other people wrote, and any of them can
carry text that tells it to do something else. So Agentome does not rely on the agent behaving:
each run gets only what its task needs, and the rest is out of its reach whatever it does.

## Where a run happens

A person's agents run in their **place**, a container the platform makes for them on the server.
Each run in it gets two containers of its own, made when it starts and deleted when it ends:

- The **CLI container** runs the official Claude Code or Codex, unmodified, with the person's
  sign-in to their subscription. Claude Code's file tools are kept out of its home folder, where
  the sign-in is. Codex has no way to run anything there at all: every command and edit it makes
  goes to Codex's own executor, `codex exec-server`, in the sandbox, and the CLI container has no
  working folder of the agent's, so a repository's `.codex` is never read beside the sign-in.
- The **sandbox** runs every command the agent runs: builds, tests, `git`, scripts. It has the
  task's repository and nothing of the sign-in, the CLI or the platform's own settings. The CLI's
  `bash` and `git` pass each command there.

So a command the agent was talked into cannot read the subscription's token, and the CLI never
runs a command itself. The container is marked as the CLI's by a read-only mount nothing in it can
remove, so `bash` there never runs a command beside the sign-in. A repository's own `CLAUDE.md` is
read by Agentome, not the CLI: its imports reach files inside the repository only. Every place and every run has a kernel of its own under gVisor, not the
host's: the launcher makes none without it, unless an admin chose the host's kernel by name. A place has a read-only root, no Linux capabilities, at most 2 CPUs and 8 GB of memory,
and no DNS for names outside. The service that makes containers holds no Docker socket: a guard does, with no
network, and passes only the calls that make places and runs, each body field by field under its
exact name and written anew by the guard, and only on containers labelled as a place's. Places, the sandbox and a run's own
Docker never get the host's folders, ports or namespaces.

A place runs a person's subscription only while that person is at work in Agentome, unless they
turned on **Work while I'm away** for their own place themselves, in the browser; an admin can turn
that off for everyone. The person signs the CLI in themselves, in the place's terminal. Agentome neither reads nor keeps the
sign-in, and never runs a subscription for anyone else.

## What a run can reach

A place has no way out but the egress proxy, which knows every call's token and lets it through to
its own list only:

- **The CLI** reaches the model vendors and Agentome.
- **Commands** reach Agentome and the hosts the task's project allows, which an admin lists:
  the company's GitLab, Jira, a package mirror. Not the model vendors.
- **A project's services**, such as its database, are reached by name from the sandbox and reach
  nothing outside.

The proxy takes only HTTPS through `CONNECT`, to the name that was asked for, on port 443 unless
the list names another. It checks the address a name resolves to, never connects to the
server's own machine, to link-local addresses or to a cloud's metadata service, and reaches
the company's private networks only for a host an admin listed by its full name. It reads the server name of each connection and
nothing inside it. Every connection it lets through is in the run's log as it ends, with the
entry of the list that let it out, the bytes each way and how long it lasted; every host it
refuses is there with why. A refused host shows in the project's **Network** section with
**Allow** beside it; a host allowed that way reaches public addresses only, since a run chose its
name.

## Where the secrets are

| Secret                                    | Where it is                                       | Who uses it                                   |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| A person's subscription sign-in           | Their place's home volume, on the server          | The CLI in a run's CLI container              |
| The code host, Jira and MCP server tokens | The Agentome database, encrypted                  | The server's gateway and git proxy            |
| Model API keys, for agents on the server  | The Agentome database, encrypted                  | The server's relay, which adds them to a call |
| A run's token                             | The run, until it ends                            | The run's tools, git and way out              |
| The installation's secret key             | The data folder, or the environment on Kubernetes | The server                                    |

Integration tokens never reach a place or a computer. An agent's tools go through the server's
**MCP gateway**, with the run's token, which applies the agent's policies to each call: allow,
ask a person first, or deny. Its `git` goes through the server's **git proxy**, which adds the
code host's token on the way. The model relay does the same for API keys. A run's token stops
working when the run ends.

The database keeps these secrets under AES-256-GCM, with a key drawn from the installation's
secret key. A backup holds the database and not the key. `agentome rotate-key` seals everything
under a new key when the old one may have leaked.

## What an agent can push

The git proxy opens only the repository of the run's task, and holds every push to rules the
agent cannot change:

- only to branches named `agent/…`, never to `main`, a release branch or a tag;
- no branch is deleted, and no push options pass, so GitLab cannot be told to open or merge a
  merge request past its owner;
- a push lands first on a ref of the proxy's own, on which no pipeline runs, and moves its branch
  only when it keeps the branch's history and leaves the CI configuration as the default branch
  has it: on GitLab the CI file and every file it includes, on GitHub the `.github` folder and the
  local actions its workflows use.

A change request is opened by a tool, under the agent's policies, and merged by a person.

## People and access

- People sign in with a password and, on Enterprise, through Keycloak. Every admin also signs in
  with a code from an authenticator app.
- An agent belongs to a person, and others reach it only through grants. A project's runs reach
  only that project's connections and hosts.
- An admin may disable a person, which puts their place to sleep, and delete a place with its
  sign-in.

## What you install

Each release's images are signed and carry their build provenance and a software bill of
materials; the `agentome` package on npm names the workflow run that published it; `install.sh`
and `compose.yaml` come with signed checksums. A release goes out only when its tree holds no
secret and neither image has a critical vulnerability that already has a fix. How to check each
of these is in [Checking an image](../../deploy/OPERATIONS.md#checking-an-image).

## What Agentome does not protect

- **The pipeline still runs the agent's code.** A push to `agent/…` starts the repository's
  pipeline, which runs the tests and scripts the agent wrote. Keep CI secrets out of its reach:
  protected variables on GitLab, environments on GitHub
  ([Integrations](integrations.md#what-ci-runs-for-an-agents-push)).
- **The CLI's own traffic to its vendor is not inspected.** The proxy decides by host only;
  what the CLI sends its model is between the person's subscription and the vendor.
- **Whoever is root on the server reads everything**: the sign-ins on the places' volumes, the
  database and the key. Treat the server as you treat the code host.
- **A person's computer gets less.** An agent that runs on someone's computer works inside the
  CLI's own sandbox on that machine, with the person's key and token folders closed to it, but
  on the person's kernel and network. For a company, places on the server are the way.

Found something? Write to the address in [SECURITY.md](../../SECURITY.md); please do not open a
public issue.
