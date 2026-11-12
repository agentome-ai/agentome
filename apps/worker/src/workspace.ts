import { execFile } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { teamDir, type TeamHookConfig } from './claude/team-hook.js';
import type { Artifact, LaunchPackage } from './client.js';
import { connectionFile, describe } from './config.js';
import { rulePath, unsandboxed } from './platform.js';

// The folder of one run: `repo/`, the agent's working copy, and `profile/`, its CLAUDE.md and
// settings, next to the repository rather than in it, so that neither lands in a commit nor
// meets the repository's own CLAUDE.md. It is removed when the run ends: nothing of
// an agent stays on the computer.

export interface Workspace {
  dir: string;
  repo: string;
  profile: string;
  /** HEAD before the agent started; absent in a repository without commits. */
  base?: string;
  /** The repository on this computer the clone came from, where the agent's commits are kept. */
  local?: string;
  /** `--mcp-config`: the gateway with the run's token, where the agent cannot read it. */
  mcpConfig?: string;
  /** The git proxy the clone came through, the helper that answers its password, its file. */
  remote?: { url: string; helper: string; file: string };
  /** The clone's `.git/config` as the worker wrote it, outside the agent's reach. */
  gitConfig?: string;
  /** `--agents`: the members of a team run as subagents. */
  agents?: Record<string, unknown>;
}

// The shapes the server allows: a path from it never leaves the profile, whatever it says.
const MEMORY_PATH = /^(MEMORY\.md|memory\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md)$/;

/** An agent's memory beside its CLAUDE.md: read only, like the rest of the profile. */
function writeMemory(base: string, documents: { path: string; content: string }[]) {
  for (const { path, content } of documents) {
    if (!MEMORY_PATH.test(path))
      throw new Error(`The server sent a memory path out of shape: ${path}`);
    if (path.startsWith('memory/'))
      mkdirSync(join(base, 'memory'), { recursive: true, mode: 0o700 });
    writeFileSync(join(base, path), content, { mode: 0o400 });
  }
  if (documents.some(({ path }) => path.startsWith('memory/')))
    chmodSync(join(base, 'memory'), 0o500);
}

// Claude Code's skill names, and the keys of team members; one from the server never leaves
// its folder either.
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * An agent's skills as skills/<name>/SKILL.md, read only; its CLAUDE.md or prompt lists them.
 * Plain files the agent reads, never Claude Code's own skills (.claude/skills, which
 * --setting-sources user keeps from loading): the CLI would act on their frontmatter's hooks,
 * allowed-tools and inline commands.
 */
function writeSkills(base: string, skills: { name: string; content: string }[]) {
  if (skills.length === 0) return;
  for (const { name, content } of skills) {
    if (!SKILL_NAME.test(name))
      throw new Error(`The server sent a skill name out of shape: ${name}`);
    mkdirSync(join(base, 'skills', name), { recursive: true, mode: 0o700 });
    writeFileSync(join(base, 'skills', name, 'SKILL.md'), content, { mode: 0o400 });
    chmodSync(join(base, 'skills', name), 0o500);
  }
  chmodSync(join(base, 'skills'), 0o500);
}

const REPO_SKILLS_LIMIT = 50;

/**
 * The skills the repository keeps in .claude/skills for whoever works in it, as a section of the
 * profile's CLAUDE.md: plain files the agent reads, for the same reason as its owner's. A link
 * is skipped, so a description never comes from a file outside the clone.
 */
export function repositorySkillsSection(repo: string): string {
  const root = join(repo, '.claude', 'skills');
  const plainDir = (path: string) => {
    try {
      return lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  if (!plainDir(join(repo, '.claude')) || !plainDir(root)) return '';
  const lines = readdirSync(root)
    .filter((name) => SKILL_NAME.test(name) && plainDir(join(root, name)))
    .sort()
    .flatMap((name) => {
      const file = join(root, name, 'SKILL.md');
      let text: string;
      try {
        if (!lstatSync(file).isFile()) return [];
        text = readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
      const description = (/^description:\s*(.+)$/m.exec(frontmatter)?.[1] ?? '')
        .replace(/[\p{Cc}]/gu, ' ')
        .trim()
        .slice(0, 300);
      return [`- **${name}** (.claude/skills/${name}/SKILL.md): ${description}`];
    })
    .slice(0, REPO_SKILLS_LIMIT);
  if (lines.length === 0) return '';
  return `\n## The repository's skills\n\nThe repository you work in keeps these skills for whoever works in it. When a task calls for one, read its SKILL.md first and follow it.\n\n${lines.join('\n')}\n`;
}

type Team = NonNullable<LaunchPackage['team']>;

/**
 * The members of a team run: their memory and skills in the profile's team/<key>/, the
 * hook's config beside the profile, and the subagents for `--agents`. Each member's gateway server
 * is the lead's, in `mcp.json` with the member's token, and the subagent inherits it: defined in
 * the subagent, the token would be in the CLI's arguments, which any process on the computer may
 * list, and --strict-mcp-config blocks a subagent's own servers anyway (CLI 2.1.280).
 */
function writeTeam(dir: string, profile: string, team: Team, stepUrl: string, mcpConfig: string) {
  const keys = team.members.map(({ key }) => key);
  for (const key of keys) {
    if (!SKILL_NAME.test(key)) throw new Error(`The server sent a team key out of shape: ${key}`);
  }
  mkdirSync(join(profile, 'team'), { mode: 0o700 });
  const agents: Record<string, unknown> = {};
  for (const member of team.members) {
    const base = join(profile, 'team', member.key);
    mkdirSync(base, { mode: 0o700 });
    writeMemory(base, member.memoryDocuments);
    writeSkills(base, member.skills);
    chmodSync(base, 0o500);
    const others = keys.filter((key) => key !== member.key).map((key) => `mcp__agentome-${key}`);
    agents[member.key] = {
      description: member.description,
      prompt: `${member.prompt}\nThe profile folder is ${profile}.\n`,
      ...(member.modelPref ? { model: member.modelPref } : {}),
      // No subagents of its own, and no gateway but its own: the lead's and the others' act as them.
      disallowedTools: ['Agent', 'mcp__agentome', ...others],
    };
  }
  chmodSync(join(profile, 'team'), 0o500);
  const steps = team.steps.map((step) => step.members);
  const config: TeamHookConfig = { mode: team.mode, keys, steps, stepUrl, mcpConfig };
  mkdirSync(teamDir(dir), { mode: 0o700 });
  writeFileSync(join(teamDir(dir), 'config.json'), JSON.stringify(config), { mode: 0o400 });
  return agents;
}

/** What a run reports of its commits: enough to read, too little to outgrow the finish body. */
const MAX_COMMITS = 100;
const MAX_SUBJECT = 200;

export const workspaceDir = (home: string, runId: string) => join(home, 'runs', runId);

/**
 * The folder Claude Code keeps for a working directory: under its config folder, the path with
 * every other character than a letter or digit as `-`. --no-session-persistence keeps the
 * transcript out of it, yet the CLI still saves subagents' records and long tool output there
 * (CLI 2.1.280), so it goes with the run's folder.
 */
export function cliProjectDir(cwd: string, env: NodeJS.ProcessEnv): string {
  const config = env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.claude');
  return join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Removes a run's folder and what the CLI kept of it elsewhere. */
export function removeRun(home: string, runId: string, env: NodeJS.ProcessEnv): void {
  const dir = workspaceDir(home, runId);
  removeWorkspace(cliProjectDir(join(dir, 'repo'), env));
  removeWorkspace(dir);
}

/** Removes the folders of every earlier run, and what the CLI kept of each. */
export function removeRuns(home: string, env: NodeJS.ProcessEnv): void {
  const runs = cliProjectDir(join(home, 'runs'), env);
  const projects = dirname(runs);
  const prefix = `${basename(runs)}-`;
  const kept = existsSync(projects) ? readdirSync(projects) : [];
  for (const name of kept.filter((entry) => entry.startsWith(prefix))) {
    removeWorkspace(join(projects, name));
  }
  try {
    removeWorkspace(join(home, 'runs'));
  } catch (error) {
    // A server seat's runs folder is a mount (compose.yaml): emptied, it stays, and need not go.
    if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
  }
}

/** `timeout`: what is left of the run's time limit, which the clone counts against too. */
export async function prepareWorkspace(
  home: string,
  launch: LaunchPackage,
  options: { signal: AbortSignal; timeout: number; server?: boolean },
) {
  if (options.server !== true) refuseStrangeTools(launch.workspace.profile.settings.allowedTools);
  const dir = workspaceDir(home, launch.run.id);
  const [repo, profile] = [join(dir, 'repo'), join(dir, 'profile')];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = launch.task?.repository;
  // A connected repository comes through the proxy, which holds the host's token.
  const remote = launch.workspace.git && proxyOf(dir, launch.workspace.git);
  const origin = remote
    ? { from: remote.url, local: false }
    : source
      ? sourceOf(source)
      : undefined;
  const create = origin
    ? ['clone', '--quiet', '--no-hardlinks', '--', origin.from, repo]
    : ['init', '--quiet', '--initial-branch=main', repo];
  await git([...(remote ? ['-c', `credential.helper=${remote.helper}`] : []), ...create], dir, {
    ...options,
    allow: remote ? 'http:https' : 'file:git:http:https',
    create: true,
  });
  if (remote) {
    // The agent's own git pushes with it; the empty entry first drops the person's helpers, so
    // that the password never lands in their keychain.
    await git(['config', 'credential.helper', ''], repo);
    await git(['config', '--add', 'credential.helper', remote.helper], repo);
  }
  // The agent's commits carry its name, not that of the person whose ~/.gitconfig the CLI reads.
  const name = launch.agent.name
    .replace(/[\p{Cc}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  await git(['config', 'user.name', name || 'Agentome agent'], repo);
  await git(['config', 'user.email', `agent-${launch.agent.id.slice(0, 8)}@agentome.ai`], repo);
  const base = await head(repo);
  // The agent may write .git/config (a checkout's upstream, a remote of its own); the worker's
  // own git at the end reads the copy it wrote, not what the agent left (see branchArtifact).
  const gitConfig = join(dir, 'git-config');
  copyFileSync(join(repo, '.git', 'config'), gitConfig);

  // Beside the profile, not in it: the agent reads its profile (the CLAUDE.md there), and this
  // file holds the run token, with which it could forge its own transcript or end its run.
  const mcpConfig = launch.workspace.mcp ? join(dir, 'mcp.json') : undefined;
  // A team needs the gateway: each member's tools act as it, and the hook asks there.
  const team = mcpConfig ? launch.team : undefined;
  if (mcpConfig && launch.workspace.mcp) {
    const server = (token: string) => ({
      type: 'http',
      url: launch.workspace.mcp?.url,
      headers: { Authorization: `Bearer ${token}` },
    });
    const members = (team?.members ?? []).map((m) => [`agentome-${m.key}`, server(m.token)]);
    const servers = {
      mcpServers: { agentome: server(launch.run.token), ...Object.fromEntries(members) },
    };
    writeFileSync(mcpConfig, `${JSON.stringify(servers, null, 2)}\n`, { mode: 0o600 });
  }

  mkdirSync(profile, { mode: 0o700 });
  const claudeMd = launch.workspace.profile.claudeMd + repositorySkillsSection(repo);
  writeFileSync(join(profile, 'CLAUDE.md'), claudeMd, { mode: 0o400 });
  writeMemory(profile, launch.agent.memoryDocuments ?? []);
  writeSkills(profile, launch.agent.skills ?? []);
  const { projectMd } = launch.workspace.profile;
  if (projectMd) writeFileSync(join(profile, 'PROJECT.md'), projectMd, { mode: 0o400 });
  const agents =
    team && mcpConfig
      ? writeTeam(dir, profile, team, `${launch.workspace.mcp?.url}/team-step`, mcpConfig)
      : undefined;
  const hooks = agents ? teamHooks(dir, options.timeout) : undefined;
  const laptop = options.server !== true;
  const settings = JSON.stringify(
    profileSettings(launch, home, dir, mcpConfig, hooks, laptop),
    null,
    2,
  );
  writeFileSync(join(profile, 'settings.json'), `${settings}\n`, { mode: 0o400 });
  chmodSync(profile, 0o500);
  const local = origin?.local ? origin.from : undefined;
  return {
    dir,
    repo,
    profile,
    base,
    local,
    mcpConfig,
    remote,
    gitConfig,
    agents,
  } satisfies Workspace;
}

/**
 * The proxy's password in a file beside the clone, and a helper that only reads it. The agent may
 * read the password — its git pushes with it, and it opens nothing but this repository's proxy —
 * but not change the file: the run's folder is outside what its sandbox may write, so the worker's
 * own git, which runs outside the sandbox, reads only what the worker wrote.
 */
function proxyOf(dir: string, access: NonNullable<LaunchPackage['workspace']['git']>) {
  const file = join(dir, 'git-credentials');
  writeFileSync(file, `username=${access.username}\npassword=${access.password}\n`, {
    mode: 0o600,
  });
  const quoted = `'${file.replaceAll("'", "'\\''")}'`;
  return { url: access.url, helper: `!f() { test "$1" = get && cat ${quoted}; }; f`, file };
}

// Where a person's keys and tokens live, from their home folder. A run reads most of the disk,
// since its toolchains are all over it, and what it reads it can push to its branch or print
// into its transcript: an agent that follows text planted in an issue or a file would take
// these out. Closed by name, to sandboxed commands and to the file tools both.
const CREDENTIALS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.config/gcloud',
  '.config/gh',
  '.config/git/credentials',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.password-store',
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.local/share/keyrings',
  '.mozilla',
  '.config/google-chrome',
  '.config/chromium',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
];

/** Those of them this computer has, and where a link among them leads. */
function credentialPaths(): string[] {
  const found = CREDENTIALS.map((place) => join(homedir(), place)).filter((path) =>
    existsSync(path),
  );
  return [...new Set(found.flatMap((path) => [path, realpathSync(path)]))];
}

// What a computer runs for an agent: reading, the plan, the shell in its sandbox, a team's
// members, and the gateway's servers. Edits need no rule, since acceptEdits takes them in the
// workspace only, while a rule for one would take them anywhere on the person's disk.
const LAPTOP_TOOLS = new Set([
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'Agent',
]);
const GATEWAY_SERVER = /^mcp__agentome(-[a-z0-9-]+)?$/;

function refuseStrangeTools(tools: readonly string[]): void {
  const strange = tools.find((tool) => !LAPTOP_TOOLS.has(tool) && !GATEWAY_SERVER.test(tool));
  if (strange !== undefined) {
    throw new Error(
      `The server asked for ${String(strange).slice(0, 80)}, which is not a tool this computer runs for an agent.`,
    );
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A computer's sandbox is the worker's to write, not the server's to send: a server that was
 * broken into, or someone answering in its place, would switch it off and have a shell on every
 * connected computer as its person. From the launch package come only the hosts the run may
 * reach, which are the platform's own, and connections to this computer itself when those hosts
 * are this computer and nothing else (a server tried out on the computer).
 */
/** The hosts a computer run may reach, as the launch package's sandbox names them. */
export function platformHosts(sandbox: Record<string, unknown>): string[] {
  return strings(((sandbox.network ?? {}) as Record<string, unknown>).allowedDomains);
}

function laptopSandbox(given: Record<string, unknown>) {
  const network = (given.network ?? {}) as Record<string, unknown>;
  const allowedDomains = platformHosts(given);
  const local =
    network.allowLocalBinding === true && allowedDomains.every((host) => LOOPBACK.has(host));
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains, strictAllowlist: true, ...(local && { allowLocalBinding: true }) },
  };
}

/**
 * The CLI's settings for the run: the platform's sandbox, plus the places on this computer the
 * agent must not reach — the seat token, with which it could claim the runs of other agents,
 * the gateway's config, which holds the run token, the person's own keys and tokens,
 * and its own profile, where it could loosen its sandbox. Being outside the workspace
 * is not enough: sandboxed commands may read the whole disk and write the `--add-dir` folders,
 * and the file tools obey the deny rules, not the sandbox.
 */
function profileSettings(
  launch: LaunchPackage,
  home: string,
  dir: string,
  mcpConfig: string | undefined,
  hooks: Record<string, unknown> | undefined,
  laptop: boolean,
) {
  const profile = join(dir, 'profile');
  const secrets = [connectionFile(home), ...(mcpConfig ? [mcpConfig] : [])];
  // The team hook's state: an agent that wrote it could open a step its owner has not approved.
  const kept = hooks ? [profile, teamDir(dir)] : [profile];
  // A server seat's container is its sandbox, and the server says what goes on in it. A Windows
  // computer has none: its admin allowed it to run the agent's commands without one, and the
  // rules below keep only the file tools out of these places there.
  const { filesystem: sent, ...asSent } = launch.workspace.profile.settings.sandbox;
  const sandbox = !laptop ? asSent : unsandboxed() ? { enabled: false } : laptopSandbox(asSent);
  const filesystem = laptop ? {} : sent;
  const credentials = credentialPaths();
  const denyRead = [...strings(sent?.denyRead), ...secrets, ...credentials];
  const denyWrite = [...strings(sent?.denyWrite), ...kept];
  return {
    // Claude Code protects .git/config by default, which breaks `git checkout <branch>` and
    // `git push -u`: the clone is the agent's to configure, and the worker reads only its
    // own copy of that file. Hooks stay protected, and the worker never runs them anyway.
    sandbox: {
      ...sandbox,
      filesystem: { ...filesystem, denyRead, denyWrite, allowGitConfig: true },
    },
    // `//` makes a rule's path absolute. /proc holds the CLI's own environment, and on a server
    // seat that has the model connection's key: with no shell, the file tools were
    // the way left to it. Read rules hold for Grep and Glob too.
    permissions: {
      deny: [
        'Read(//proc)',
        'Read(//proc/**)',
        'Read(//sys)',
        'Read(//sys/**)',
        ...secrets.map((secret) => `Read(${rulePath(secret)})`),
        ...credentials.flatMap((path) => [`Read(${rulePath(path)})`, `Read(${rulePath(path)}/**)`]),
        ...kept.map((folder) => `Edit(${rulePath(folder)}/**)`),
      ],
    },
    ...(hooks ? { hooks } : {}),
  };
}

/**
 * The team hook on the lead's assignments, on the members' tools, and after an assignment, which
 * is when its agent has reported. It may wait for the owner as long as the run may last.
 */
function teamHooks(dir: string, timeoutMs: number) {
  const program = [process.execPath, ...process.execArgv, realpathSync(process.argv[1] ?? '')];
  const command = [...program, 'team-hook', dir]
    .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
    .join(' ');
  const hook = { type: 'command', command, timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) };
  return {
    PreToolUse: [{ matcher: 'Agent|Task|mcp__agentome-.*', hooks: [hook] }],
    PostToolUse: [{ matcher: 'Agent|Task', hooks: [hook] }],
  };
}

/** A URL as it is, or a path on this computer (`local`): absolute, or from `~`. */
function sourceOf(repository: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repository)) return { from: repository, local: false };
  const path = repository.startsWith('~/') ? join(homedir(), repository.slice(2)) : repository;
  if (isAbsolute(path)) return { from: path, local: true };
  throw new Error(`The task's repository must be a URL or an absolute path, not "${repository}".`);
}

/**
 * The commits the agent made, as a `branch` artifact; nothing when it made none. With `keep`, a
 * clone of a repository on this computer leaves them there as the branch `agentome/<run id>`
 * (`pushedTo`), so that they outlive the run's folder; `failure` says why they could not be.
 */
export async function branchArtifact(
  workspace: Workspace,
  runId: string,
  keep: boolean,
): Promise<{ artifact?: Artifact; failure?: string }> {
  // A `.git` the agent swapped for a link or a file would point the worker at another repository.
  if (!lstatSync(join(workspace.repo, '.git'), { throwIfNoEntry: false })?.isDirectory()) return {};
  // And a `.git/config` it rewrote could send the worker's push, password and all, elsewhere
  // (`url.<x>.insteadOf` applies to explicit URLs too): the worker's git reads its own copy. The
  // copy goes in place of what is there, never through it: a link left at `.git/config` would
  // have it written over the file the link names, which may be any file of the person's.
  if (workspace.gitConfig !== undefined) {
    const config = join(workspace.repo, '.git', 'config');
    rmSync(config, { recursive: true, force: true });
    copyFileSync(workspace.gitConfig, config, constants.COPYFILE_EXCL);
  }
  const tip = await head(workspace.repo);
  if (tip === undefined || tip === workspace.base) return {};
  const range = workspace.base === undefined ? tip : `${workspace.base}..${tip}`;
  const format = ['--no-show-signature', `--max-count=${MAX_COMMITS}`, '--format=%H%x09%s'];
  const log = await git(['log', ...format, range, '--'], workspace.repo);
  const commits = log.match(/^.+$/gm)?.map((line) => {
    const [sha = '', ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t').slice(0, MAX_SUBJECT) };
  });
  if (!commits?.length) return {};
  if (keep && workspace.remote !== undefined) {
    return keepOnHost(workspace.repo, workspace.remote, tip, runId, commits);
  }
  const ref = `agentome/${runId}`;
  let pushedTo: string | null = null;
  let failure: string | undefined;
  if (keep && workspace.local !== undefined) {
    // A new branch, never one of the person's and never forced, its objects checked on the way
    // in; and to a path only, whatever the clone's configuration makes of URLs.
    const push = ['push', '--quiet', '--no-follow-tags', '--no-recurse-submodules', '--'];
    const target = [workspace.local, `${tip}:refs/heads/${ref}`];
    const options = { allow: 'file', timeout: 60_000 };
    try {
      await git(['-c', 'transfer.fsckObjects=true', ...push, ...target], workspace.repo, options);
      pushedTo = workspace.local;
    } catch (error) {
      failure = describe(error);
    }
  }
  return { artifact: { kind: 'branch', ref, meta: { commits, pushedTo } }, failure };
}

type Commits = { sha: string; subject: string }[];

/**
 * The commits a run leaves on the host: on a branch under agent/ that the agent pushed already, or
 * pushed now to `agent/run-<id>` through the proxy. Which branches there are, the host says, not
 * the clone's remote-tracking refs, which the agent can move without pushing.
 */
async function keepOnHost(
  repo: string,
  remote: NonNullable<Workspace['remote']>,
  tip: string,
  runId: string,
  commits: Commits,
): Promise<{ artifact: Artifact; failure?: string }> {
  const kept = (ref: string) => ({
    artifact: { kind: 'branch' as const, ref, meta: { commits, pushedTo: remote.url } },
  });
  const ref = `agent/run-${runId}`;
  const options = { allow: 'http:https', timeout: 60_000 };
  const auth = ['-c', `credential.helper=${remote.helper}`];
  try {
    const heads = await git(
      [...auth, 'ls-remote', '--heads', '--', remote.url, 'refs/heads/agent/*'],
      repo,
      options,
    );
    for (const line of heads.match(/^.+$/gm) ?? []) {
      const [sha = '', name = ''] = line.split('\t');
      // An unknown commit fails too: the host's branch is not one this clone pushed.
      const holds = await git(['merge-base', '--is-ancestor', tip, sha], repo).then(
        () => true,
        () => false,
      );
      if (holds) return kept(name.slice('refs/heads/'.length));
    }
    const push = ['push', '--quiet', '--no-follow-tags', '--no-recurse-submodules', '--'];
    await git(
      [...auth, '-c', 'transfer.fsckObjects=true', ...push, remote.url, `${tip}:refs/heads/${ref}`],
      repo,
      options,
    );
    return kept(ref);
  } catch (error) {
    return {
      artifact: { kind: 'branch', ref, meta: { commits, pushedTo: null } },
      failure: describe(error),
    };
  }
}

/** Removes the folder of a run, whatever the agent left in it, read-only folders included. */
export function removeWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A folder without write permission keeps its entries: the profile is one such folder.
    writable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writable(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) writable(join(dir, entry.name));
  }
}

/** The commit of HEAD; nothing in a repository without commits, which has no HEAD yet. */
const head = (repo: string) =>
  git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], repo).then(
    (sha) => sha.trim(),
    () => undefined,
  );

// Git's own spelling of the null device: Git for Windows reads /dev/null as NUL, but cannot open
// \\.\nul, which is what Node calls it there.
const GIT_NULL = '/dev/null';

// The worker's own git runs outside the sandbox, on a repository the agent controls. So: never
// the person's credentials — no credential helper, no prompt, no ssh with their keys —
// and nothing of their configuration or the repository's that starts a program.
// An empty GIT_ASKPASS keeps git from running the askpass program the repository's config names
// when the proxy turns a password down. And git never fetches an object the clone lacks: a
// promisor remote's `uploadpack` is a command line.
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: GIT_NULL,
  GIT_NO_LAZY_FETCH: '1',
};
const GIT_FLAGS = ['credential.helper=', 'core.fsmonitor=false', `core.hooksPath=${GIT_NULL}`];
type GitOptions = { signal?: AbortSignal; timeout?: number; allow?: string; create?: boolean };

/**
 * `allow`: the transports git may use, none unless the call names them; never ssh, whose keys
 * are the person's. `create`: the call makes the repository (clone, init) rather than works in
 * the one at `cwd`.
 */
function git(args: string[], cwd: string, options: GitOptions = {}) {
  const { allow = '', create = false, ...run } = options;
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'));
  // In a clone, git is told where its repository is rather than left to find out. The agent may
  // write `.git/commondir`, which names the folder git takes the configuration, the objects and
  // the refs from: with one of its own there, the worker's copy of `.git/config` is not what git
  // reads. Without a ceiling, a repository that is not there yet is looked for in the folders
  // above.
  const own = join(cwd, '.git');
  const scope = {
    GIT_ALLOW_PROTOCOL: allow,
    ...(create ? { GIT_CEILING_DIRECTORIES: dirname(cwd) } : { GIT_DIR: own, GIT_COMMON_DIR: own }),
  };
  const env = { ...Object.fromEntries(inherited), ...GIT_ENV, ...scope };
  const flags = GIT_FLAGS.flatMap((setting) => ['-c', setting]);
  const command = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c');
  return new Promise<string>((resolve, reject) => {
    execFile('git', [...flags, ...args], { cwd, env, ...run }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`git ${command} failed: ${stderr.trim() || error.message}`));
    });
  });
}
