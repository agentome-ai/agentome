# Agentome worker

The seat on an employee's computer. It asks the server for a run of one of its
owner's agents, works on it in a temporary folder with the official `claude` CLI under the
owner's own subscription, reports the transcript, the result, the commits and the usage, and
removes the folder. It takes runs only while somebody is at the computer, one at a time, and
keeps nothing of an agent between runs.

`src/claude/` is the Claude Code adapter (its own [README](src/claude/README.md)); the rest is
the seat: `cli.ts` (the commands), `loop.ts` (claim, one run at a time, presence), `run.ts`
(events, heartbeat, finish), `workspace.ts` (the run's folder), `service.ts` (launchd and
systemd), `presence.ts` (idle time), `client.ts` (the seat protocol, also in the server's `/openapi.json`),
`config.ts` (files and settings).

## Connect a computer

You need Node.js 20 or later and Claude Code installed and signed in (`claude`, then `/login`)
with the account whose subscription the agent may use. In Agentome, open Admin, Computers, Connect a
computer, and paste the command into a terminal on the computer:

```sh
curl -fsSL https://agentome.example.com/connect | sh -s -- K7QX-M2PH
```

The code works once, for ten minutes. The script downloads the worker as one file into
`~/.agentome/bin/`, checks its SHA-256, connects and installs the service; if the service cannot
be installed, the computer is connected all the same and `agentome-worker run` takes runs in a
terminal. Run again with a new code, it puts the current worker in place and connects the
computer anew, as a new entry in Admin, Computers: revoke the old one. Then `~/.agentome/bin/agentome-worker status` shows the server, whether
the worker runs, its last claim, the run in progress and the service, and
`~/.agentome/bin/agentome-worker uninstall-service` removes the service.

The file is built by `pnpm --filter @agentome/worker build` (esbuild, `shared` and `costs`
inlined) into `dist/agentome-worker.mjs`, and the image serves it (`apps/server/src/connect.ts`).

### From a checkout

A server run from a checkout (`pnpm dev`) has no bundle to serve, and its command runs the worker
from a checkout. You need Node 22, pnpm and `pnpm install` done.

1. Copy the code from Admin, Computers, Connect a computer.
2. Connect:

   ```sh
   pnpm --filter @agentome/worker connect <code> --server http://localhost:3000
   ```

3. Take runs in the background, whenever you are logged in:

   ```sh
   pnpm --filter @agentome/worker install-service
   ```

   Or in this terminal, until Ctrl-C: `pnpm --filter @agentome/worker start`.

4. Check it: `pnpm --filter @agentome/worker status` shows the server, whether the worker runs,
   its last claim, the run in progress and the service. The log is `~/.agentome/logs/worker.log`.

`pnpm --filter @agentome/worker uninstall-service` stops the service, which first cancels and
finishes a run in progress, and removes it. To disconnect the computer, revoke it in Admin,
Seats.

## What the worker does

- **Claims.** `GET /api/seats/claim` holds for up to 25 s and answers a launch package or
  nothing; the worker asks again at once, and after a network error waits 1 s, doubling to 30 s.
- **Only while somebody is there.** Before each claim it reads how long the keyboard and the mouse
  have been idle (macOS: `ioreg -c IOHIDSystem`; Linux: `xprintidle`, else `loginctl`; Windows:
  `GetLastInputInfo` through PowerShell). Past
  the seat's idle time it takes nothing and looks again a minute later. That time is set by the
  owner on the platform (Admin, Computers, Settings) and comes with every claim answer;
  `AGENTOME_WORKER_IDLE_MINUTES` is only the value until the first answer. Where the idle time
  cannot be read, somebody counts as present; the other half of the rule is that the service
  belongs to the login session.
- **One run at a time,** in `~/.agentome/runs/<run id>/`: `repo/` is a clone of the task's
  repository (a local path or a URL, without credentials) or a new, empty repository; `profile/`
  holds the agent's `CLAUDE.md` and `settings.json`. `claude` works in `repo/` with the profile
  through `--add-dir` and `--settings`, under the owner's subscription only: an API key in the
  environment is never passed on. The run's time limit counts the clone and `claude` together, and not the time the run stood
  waiting for its owner's answer to a tool call: the server says in each heartbeat how long that
  was, and the limit moves by it.
- **Reports.** Events go to the server once a second or 50 at a time, again after a failure (the
  server keeps each `seq` once); a heartbeat every 30 s. A cancel from the server stops `claude`;
  the run ends as `cancelled`. Finish carries the status, the final text as the summary and as
  a `report`, the agent's new commits as a `branch` artifact, and the usage per model.
- **Keeps the agent's commits.** The agent commits under its own name,
  `agent-<first 8 characters of its id>@agentome.ai`, which the clone gets in its configuration.
  When the run is done and the task's repository is a path on this computer, the worker pushes
  the new commits there as the branch `agentome/<run id>`: a new branch only, never one of
  yours, never forced. The `branch` artifact names it (`ref`) and the repository
  (`meta.pushedTo`). A repository given by URL keeps nothing until runs push through the
  server's git proxy, and neither does a run that did not end `done`: `pushedTo` is
  then `null`. A push that fails is a note in the transcript (`push_failed`), not a failed run.
- **Cleans up.** The run's folder is removed after finish, whatever happened, and at start the
  folders a killed worker left behind; `AGENTOME_WORKER_KEEP_WORKSPACES=1` keeps them.
- **Stops** on Ctrl-C or SIGTERM, after cancelling and finishing the run in progress. When the
  server no longer knows the seat (401), it says "This computer was disconnected; connect it
  again" and exits; connect again with a new code and run `install-service` again.

## The service

`install-service` writes a launchd agent, `~/Library/LaunchAgents/ai.agentome.worker.plist`, on
macOS, and a `systemd --user` unit, `~/.config/systemd/user/agentome-worker.service`, on Linux,
and starts it. Both start the worker when you log in, restart it after a crash but not after a
clean exit (a disconnected computer would only be refused again), give it 60 s to finish a run
when stopped, and append its output to `~/.agentome/logs/worker.log`. A user unit stops with
your last session unless lingering is on; leave it off.

On Windows it is the scheduled task **Agentome worker**, at the person's logon, in their session
(`InteractiveToken`), with no time limit, its files in `%LOCALAPPDATA%\Agentome`. The task runs
`conhost --headless` so that no console window opens, and in it `agentome-worker service`, which
starts the worker, appends its output to the log and starts it again ten seconds after a crash;
Task Scheduler has no restart of its own for that. `uninstall-service` ends that process tree,
a run in progress with it, and deletes the task. Windows has no sandbox for the agent's
commands: a Windows computer claims with `platform=win32`, and the server hands it runs only once
an admin allows it to run without one (Admin, Computers). Its CLIs are found on `PATH` as `.exe`,
or as npm's `.cmd`, whose script this Node starts; a stop is `taskkill /T /F`.

The service runs the same Node and script as the command that installed it, with that shell's
`PATH` (so that it finds `claude`), its proxy and certificate variables (`HTTPS_PROXY`,
`NODE_EXTRA_CA_CERTS` and the like) and its `AGENTOME_WORKER_*` settings; never a key or a
token. Sign in to Claude Code with `claude` itself: a login kept only in an environment variable
does not reach the service. Run `install-service` again after changing a setting, upgrading
Node, reinstalling dependencies or connecting again.

## Settings

| Variable                          | Purpose                                                               | Default       |
| --------------------------------- | --------------------------------------------------------------------- | ------------- |
| `AGENTOME_WORKER_HOME`            | Folder of the connection, the state, the log and the runs' folders    | `~/.agentome` |
| `AGENTOME_WORKER_IDLE_MINUTES`    | Idle minutes until the server names the seat's own (Admin, Computers) | `15`          |
| `AGENTOME_WORKER_KEEP_WORKSPACES` | `1` keeps the folders of finished runs, to look into one              | Unset         |

## Security invariants

- **The seat token stays with the worker.** It is in `~/.agentome/config.json` (`0600`, in a
  `0700` folder), outside every workspace, and never in a log, in the environment or the
  arguments of `claude`, or in a run's folder. Being outside the workspace is not enough by
  itself: sandboxed commands may read the whole disk, and the file tools obey permission rules,
  not the sandbox. So every run's settings deny reading `config.json` to both
  (`sandbox.filesystem.denyRead` and a `Read(...)` deny rule). With the token an agent could
  claim the runs of its owner's other agents.
- **The run token is only in the worker's memory.** It opens the events, heartbeat and finish
  of one run and dies with finish.
- **The agent cannot change its own settings.** `profile/` is read-only (`0500`, files `0400`),
  and, since the owner of a file can make it writable again, its settings deny writing there to
  sandboxed commands (`denyWrite`) and to the file tools (an `Edit(...)` deny rule).
- **No personal credentials.** The worker's git uses no credential helper, never prompts, does
  not speak ssh (whose keys are the person's), reads neither the person's nor the system's git
  configuration, runs no hooks, and never looks above the run's folder for a repository. A
  local repository is cloned without hard links; the agent's commits go back to it only as a
  new branch, over the file transport, with their objects checked, and without its hooks.
- **The repository is data.** Its `.claude` settings, hooks and `.mcp.json` never load
  ([src/claude/README.md](src/claude/README.md)); its `.git` is not trusted when the worker
  reads the agent's commits. The worker's git is told that the clone's own `.git` is both the
  git directory and the common directory, so a `commondir` file written there leads nowhere; it
  never fetches an object the clone lacks, and uses a transport only where a call names one.
- **The agent's tools come from the server.** The only MCP server `claude` gets is the
  platform's gateway (`--strict-mcp-config --mcp-config <run>/mcp.json`), opened by
  the run token. That file sits beside the profile, not in it: the agent reads its profile,
  and the run token would let it forge its transcript or end its run, so the file is mode 0600
  and denied to the agent's commands and file tools like the seat token. `MCP_TOOL_TIMEOUT` is
  the run's time limit, in milliseconds, so the CLI does not cut a call that waits for the
  owner's approval; progress notifications do not extend that timeout (CLI 2.1.280).
- **git goes through the server.** A connected repository is cloned from the platform's git
  proxy (`workspace.git`), never from the host with a token. The clone's
  `.git/config` gets an empty `credential.helper` first, which drops the person's own helpers so
  the password never lands in their keychain, and then a helper that only reads
  `<run>/git-credentials` (mode 0600). The agent may read that password: its git pushes with
  it, and it opens only this repository's proxy while the run is live. The agent cannot change
  the file, because the run's folder is outside what its sandbox may write. The agent may write
  the clone's `.git/config` (`allowGitConfig`: a checkout's upstream, `git push -u`, a remote of
  its own); the worker keeps its own copy of that file in the run's folder and puts it back
  before its own git runs, in place of whatever is at that path and never through a link left
  there, so a rewritten remote or `insteadOf` cannot send the worker's push and the password
  with it elsewhere. Hooks stay protected. When a run is done, the commits the agent left
  unpushed go to `agent/run-<id>`. The worker asks the host which `agent/*` branches exist,
  rather than trusting the clone's remote-tracking refs.
- **A revoked computer lets itself go.** When the platform revokes the seat (Admin, Computers,
  Revoke seat), the next claim answers 401; the worker stops for good and, if it runs as the
  background service, removes that service, so it does not start again into the same answer.
  `~/.agentome` stays until `connect` writes a new seat into it.
- **Nothing of the agent stays** on the computer after a run, unless
  `AGENTOME_WORKER_KEEP_WORKSPACES=1`.

- **A computer's sandbox is the worker's.** On a computer the worker writes the sandbox settings
  itself: on, failing when it is unavailable, no command outside it, a strict list of hosts.
  From the launch package it takes the hosts the run may reach and the paths denied on top,
  nothing else, and connections to the computer itself only when the server is on it. A tool
  the package asks for that is not one a computer runs for an agent (reading, the plan, `Bash`
  in the sandbox, `Agent`, the gateway's servers) fails the run with a sentence naming it. So a
  server that was broken into cannot switch the sandbox off or add a rule for edits anywhere.
  A server seat takes the package's settings: its container is its sandbox.
- **Not the person's keys and tokens.** Every run's settings deny, to sandboxed commands and to
  the file tools, the places under the person's home that hold credentials, those of them the
  computer has and where a link among them leads: ssh and gpg keys, cloud and cluster
  configurations, registry and git tokens, password stores, browser profiles, keychains and the
  CLI's own sign-in file (`CREDENTIALS` in `workspace.ts`). The server does not know the home
  folder, so the list is the worker's.

What the agent may still read is the rest of the disk, the person's home included: its
toolchains are all over it. Closing the home and letting the workspace and the toolchains
through by name (`sandbox.filesystem.allowRead`) is stronger, and waits for a check on a live
computer.

## To check on a live CLI

The tests run only against `src/claude/fixtures/fake-claude.mjs`. These questions need a real
`claude` 2.1.x under a subscription, which only the owner starts:

1. `--settings <profileDir>/settings.json` still applies under `--setting-sources user`.
2. Whether the repository's own `CLAUDE.md` is still read under these two flags. If it is not,
   pass its content in the prompt as "Repository instructions": as data, not as settings.
3. That the profile's `CLAUDE.md` is read from the `--add-dir` folder. The documentation says
   it is only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, which the worker sets.
4. What `--resume <sessionId>` does when the worktree path differs from that of the run being
   continued. If the session is not found, the launcher starts a fresh one (`resume_fallback`).
5. The deny rules hold: asked to `cat ~/.agentome/config.json` and to read it with its tools,
   and to change `profile/settings.json`, the agent is refused every time.
6. The sandbox stays on: `failIfUnavailable` and the network allowlist of the launch package.
7. After 15 minutes without touching the computer, `status` says "Taking no runs", and a queued
   run waits; it starts once you are back.
8. The service starts after logging in again, finds `claude` on its `PATH`, and its log is in
   `~/.agentome/logs/worker.log`.
9. After a done run on a repository on this computer, that repository has the branch
   `agentome/<run id>` with the agent's commit, signed with the agent's name and address, and
   your own branches are as they were.
10. Asked to `cat` a key in `~/.ssh` and to read `~/.npmrc` with its tools, the agent is refused
    both times, while `git status` and the repository's tests still run in the workspace.
11. On macOS the subscription's sign-in is in the keychain, which is not a file the settings can
    deny: asked to run `security find-generic-password -s "Claude Code-credentials" -w`, the
    agent must get nothing. If it gets the token, that is an issue of its own.
