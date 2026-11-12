import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchPackage } from '../test/fake-server.js';
import {
  branchArtifact,
  cliProjectDir,
  prepareWorkspace,
  removeRun,
  removeRuns,
  removeWorkspace,
  closedHome,
} from './workspace.js';

let dir: string;
let home: string;
let origin: string;
let start: string;
const options = { signal: new AbortController().signal, timeout: 60_000 };
const OWNER = ['-c', 'user.name=Owner', '-c', 'user.email=owner@agentome.invalid'];

/** git as the agent runs it: with the repository's identity, nothing of the tester's config. */
function git(cwd: string, ...args: string[]): string {
  const env = { PATH: process.env.PATH, HOME: dir };
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

function commit(cwd: string, file: string, message: string, identity: string[] = []): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, 'add', '--', file);
  git(cwd, ...identity, 'commit', '--quiet', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

beforeEach(() => {
  // realpath: on macOS the temporary folder is a link, and a run's settings name real paths.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentome-workspace-')));
  // The person's home, as os.homedir() reads it: a run's settings name what is in it.
  vi.stubEnv('HOME', join(dir, 'person'));
  home = join(dir, 'home');
  origin = join(dir, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '--quiet', '--initial-branch=trunk');
  start = commit(origin, 'index.js', 'Start', OWNER);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeWorkspace(dir);
});

describe('prepareWorkspace', () => {
  it('clones a local repository next to a read-only profile that keeps the agent away from the token', async () => {
    const launch = launchPackage({ repository: origin });
    const workspace = await prepareWorkspace(home, launch, options);

    expect(workspace.base).toBe(start);
    expect(workspace.local).toBe(origin);
    expect(readFileSync(join(workspace.repo, 'index.js'), 'utf8')).toBe('index.js\n');
    expect(readFileSync(join(workspace.profile, 'CLAUDE.md'), 'utf8')).toBe(
      launch.workspace.profile.claudeMd,
    );
    expect(statSync(workspace.profile).mode & 0o777).toBe(0o500);
    expect(statSync(join(workspace.profile, 'settings.json')).mode & 0o777).toBe(0o400);
    expect(JSON.parse(readFileSync(join(workspace.profile, 'settings.json'), 'utf8'))).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: ['agentome.test'], strictAllowlist: true },
        // The person's home folder closed whole, and the run's own folder open.
        filesystem: {
          denyRead: [join(home, 'config.json'), join(dir, 'person')],
          allowRead: [workspace.dir],
          denyWrite: [workspace.profile],
          allowGitConfig: true,
        },
      },
      permissions: {
        deny: [
          'Read(//proc)',
          'Read(//proc/**)',
          'Read(//sys)',
          'Read(//sys/**)',
          `Read(/${join(home, 'config.json')})`,
          `Edit(/${workspace.profile}/**)`,
        ],
      },
    });
    expect(git(workspace.repo, 'remote', 'get-url', 'origin').trim()).toBe(origin);

    removeWorkspace(workspace.dir);
    expect(existsSync(workspace.dir)).toBe(false);
  });

  it("closes the places where the person's keys and tokens are, and where a link among them leads", async () => {
    const person = join(dir, 'person');
    mkdirSync(join(person, '.ssh'), { recursive: true });
    writeFileSync(join(person, '.npmrc'), '//registry.example/:_authToken=secret\n');
    mkdirSync(join(dir, 'vault'));
    symlinkSync(join(dir, 'vault'), join(person, '.aws'));
    mkdirSync(join(person, 'code'));

    const workspace = await prepareWorkspace(home, launchPackage(), options);
    const settings = JSON.parse(readFileSync(join(workspace.profile, 'settings.json'), 'utf8')) as {
      sandbox: { filesystem: { denyRead: string[] } };
      permissions: { deny: string[] };
    };
    const closed = [
      join(person, '.ssh'),
      join(person, '.aws'),
      join(dir, 'vault'),
      join(person, '.npmrc'),
    ];
    expect(settings.sandbox.filesystem.denyRead).toEqual([
      join(home, 'config.json'),
      ...closed,
      person,
    ]);
    for (const path of closed) {
      expect(settings.permissions.deny).toContain(`Read(/${path})`);
      expect(settings.permissions.deny).toContain(`Read(/${path}/**)`);
    }
    // The rest of the home folder is closed too, to the file tools as to the commands; what is not
    // there is not named.
    expect(settings.permissions.deny).toContain(`Read(/${join(person, 'code')}/**)`);
    expect(JSON.stringify(settings)).not.toMatch(/\.gnupg/);
  });

  it('writes a computer its own sandbox, whatever the server sent, and leaves a server seat its own', async () => {
    const launch = launchPackage();
    // What a server that was broken into would send to get out of the sandbox.
    launch.workspace.profile.settings.sandbox = {
      enabled: false,
      allowUnsandboxedCommands: true,
      excludedCommands: ['git'],
      network: {
        allowedDomains: ['agentome.test'],
        allowLocalBinding: true,
        allowUnixSockets: ['/var/run/docker.sock'],
      },
      filesystem: { allowWrite: ['/'], denyRead: ['/srv/data'] },
    } as never;
    const sandboxOf = (profile: string) =>
      (
        JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as {
          sandbox: Record<string, unknown>;
        }
      ).sandbox;

    const laptop = await prepareWorkspace(home, launch, options);
    expect(sandboxOf(laptop.profile)).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['agentome.test'], strictAllowlist: true },
      filesystem: {
        denyRead: ['/srv/data', join(home, 'config.json'), join(dir, 'person')],
        allowRead: [laptop.dir],
        denyWrite: [laptop.profile],
        allowGitConfig: true,
      },
    });
    removeWorkspace(laptop.dir);

    const seat = await prepareWorkspace(home, launch, { ...options, server: true });
    expect(sandboxOf(seat.profile)).toMatchObject({
      enabled: false,
      excludedCommands: ['git'],
      filesystem: { allowWrite: ['/'] },
    });
  });

  it('lets a computer reach itself only when the server is on it', async () => {
    const launch = launchPackage();
    const network = (allowedDomains: string[]) => ({ allowedDomains, allowLocalBinding: true });
    launch.workspace.profile.settings.sandbox = { network: network(['localhost']) };
    const local = await prepareWorkspace(home, launch, options);
    expect(readFileSync(join(local.profile, 'settings.json'), 'utf8')).toContain(
      '"allowLocalBinding": true',
    );
    removeWorkspace(local.dir);
    launch.workspace.profile.settings.sandbox = {
      network: network(['localhost', 'elsewhere.test']),
    };
    const mixed = await prepareWorkspace(home, launch, options);
    expect(readFileSync(join(mixed.profile, 'settings.json'), 'utf8')).not.toContain(
      'allowLocalBinding',
    );
  });

  it('runs on a computer only the tools a computer runs for an agent', async () => {
    const launch = launchPackage();
    launch.workspace.profile.settings.allowedTools = [
      'Read',
      'Agent',
      'mcp__agentome',
      'mcp__agentome-qa',
    ];
    removeWorkspace((await prepareWorkspace(home, launch, options)).dir);
    for (const tool of ['Edit', 'Bash(curl:*)', 'WebFetch', 'mcp__other']) {
      launch.workspace.profile.settings.allowedTools = ['Read', tool];
      await expect(prepareWorkspace(home, launch, options)).rejects.toThrow(
        `The server asked for ${tool}, which is not a tool this computer runs for an agent.`,
      );
      // A server seat's tools are the server's to name.
      const seat = await prepareWorkspace(home, launch, { ...options, server: true });
      removeWorkspace(seat.dir);
    }
  });

  it('gives claude the gateway with the run token, in a file the agent cannot read', async () => {
    const launch = launchPackage({ repository: origin });
    launch.workspace.mcp = { url: 'https://agentome.test/mcp' };
    const workspace = await prepareWorkspace(home, launch, options);

    expect(workspace.mcpConfig).toBe(join(workspace.dir, 'mcp.json'));
    const config = workspace.mcpConfig ?? '';
    // The format claude mcp add writes (CLI 2.1.280), read back from the CLI itself.
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      mcpServers: {
        agentome: {
          type: 'http',
          url: 'https://agentome.test/mcp',
          headers: { Authorization: `Bearer ${launch.run.token}` },
        },
      },
    });
    expect(statSync(config).mode & 0o777).toBe(0o600);
    // Not in the profile, which the agent reads, and denied to its commands and file tools.
    expect(config.startsWith(workspace.profile)).toBe(false);
    const settings = JSON.parse(readFileSync(join(workspace.profile, 'settings.json'), 'utf8')) as {
      sandbox: { filesystem: { denyRead: string[] } };
      permissions: { deny: string[] };
    };
    expect(settings.sandbox.filesystem.denyRead).toContain(config);
    expect(settings.permissions.deny).toContain(`Read(/${config})`);
  });

  it('lays out a team: each member its own server and folder, the hook on the lead', async () => {
    const launch = launchPackage({ repository: origin });
    launch.workspace.mcp = { url: 'https://agentome.test/mcp' };
    const member = (key: string, modelPref: string | null) => ({
      key,
      description: `The ${key}`,
      prompt: `You are ${key}.`,
      modelPref,
      token: `token-${key}`,
      skills: [{ name: 'release-notes', content: '---\nname: release-notes\n---\n' }],
      memoryDocuments: [{ path: 'MEMORY.md', content: `# ${key}\n` }],
    });
    launch.team = {
      mode: 'manual',
      members: [member('backend', 'sonnet'), member('qa', null)],
      steps: [
        { members: ['backend'], note: '' },
        { members: ['qa'], note: 'Tested' },
      ],
    };
    const workspace = await prepareWorkspace(home, launch, options);

    // The tokens stay in the file the agent cannot read, never in the CLI's arguments.
    const servers = (
      JSON.parse(readFileSync(workspace.mcpConfig ?? '', 'utf8')) as {
        mcpServers: Record<string, { headers: { Authorization: string } }>;
      }
    ).mcpServers;
    expect(Object.keys(servers)).toEqual(['agentome', 'agentome-backend', 'agentome-qa']);
    expect(servers['agentome-qa']?.headers.Authorization).toBe('Bearer token-qa');
    expect(workspace.agents).toEqual({
      backend: {
        description: 'The backend',
        prompt: `You are backend.\nThe profile folder is ${workspace.profile}.\n`,
        model: 'sonnet',
        disallowedTools: ['Agent', 'mcp__agentome', 'mcp__agentome-qa'],
      },
      qa: {
        description: 'The qa',
        prompt: `You are qa.\nThe profile folder is ${workspace.profile}.\n`,
        disallowedTools: ['Agent', 'mcp__agentome', 'mcp__agentome-backend'],
      },
    });
    expect(JSON.stringify(workspace.agents)).not.toContain('token-');
    const qa = join(workspace.profile, 'team', 'qa');
    expect(readFileSync(join(qa, 'MEMORY.md'), 'utf8')).toBe('# qa\n');
    expect(existsSync(join(qa, 'skills', 'release-notes', 'SKILL.md'))).toBe(true);
    expect(statSync(qa).mode & 0o777).toBe(0o500);

    const team = join(workspace.dir, 'team');
    expect(JSON.parse(readFileSync(join(team, 'config.json'), 'utf8'))).toEqual({
      mode: 'manual',
      keys: ['backend', 'qa'],
      steps: [['backend'], ['qa']],
      stepUrl: 'https://agentome.test/mcp/team-step',
      mcpConfig: workspace.mcpConfig,
    });
    const settings = JSON.parse(readFileSync(join(workspace.profile, 'settings.json'), 'utf8')) as {
      sandbox: { filesystem: { denyWrite: string[] } };
      permissions: { deny: string[] };
      hooks: Record<string, { matcher: string; hooks: { command: string; timeout: number }[] }[]>;
    };
    // The agent may not write the hook's state, which would open steps.
    expect(settings.sandbox.filesystem.denyWrite).toContain(team);
    expect(settings.permissions.deny).toContain(`Edit(/${team}/**)`);
    const [pre] = settings.hooks.PreToolUse ?? [];
    expect(pre?.matcher).toBe('Agent|Task|mcp__agentome-.*');
    expect(pre?.hooks[0]?.command).toMatch(new RegExp(`'team-hook' '${workspace.dir}'$`));
    // As long as the run may last: a step may wait for the owner.
    expect(pre?.hooks[0]?.timeout).toBe(60);
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBe('Agent|Task');
  });

  it("puts the agent's memory beside its CLAUDE.md, read only, and only in the profile", async () => {
    const launch = launchPackage({ repository: origin });
    launch.agent.memoryDocuments = [
      { path: 'MEMORY.md', version: 3, content: '# Payments\n' },
      { path: 'memory/stripe.md', version: 1, content: 'Pinned at 19.2.\n' },
    ];
    const workspace = await prepareWorkspace(home, launch, options);
    expect(readFileSync(join(workspace.profile, 'MEMORY.md'), 'utf8')).toBe('# Payments\n');
    const stripe = join(workspace.profile, 'memory', 'stripe.md');
    expect(readFileSync(stripe, 'utf8')).toBe('Pinned at 19.2.\n');
    expect(statSync(stripe).mode & 0o777).toBe(0o400);
    expect(existsSync(join(workspace.repo, 'MEMORY.md'))).toBe(false);

    expect(existsSync(join(workspace.profile, 'PROJECT.md'))).toBe(false);
    const withProject = launchPackage({ repository: origin });
    withProject.workspace.profile.projectMd = '# Payments\n';
    const projectRun = await prepareWorkspace(home, withProject, options);
    const project = join(projectRun.profile, 'PROJECT.md');
    expect(readFileSync(project, 'utf8')).toBe('# Payments\n');
    expect(statSync(project).mode & 0o777).toBe(0o400);

    const skilled = launchPackage({ repository: origin });
    skilled.agent.skills = [
      { name: 'code-review', version: 2, content: '---\nname: code-review\n---\n' },
    ];
    const skillRun = await prepareWorkspace(home, skilled, options);
    const skill = join(skillRun.profile, 'skills', 'code-review', 'SKILL.md');
    expect(readFileSync(skill, 'utf8')).toContain('name: code-review');
    expect(statSync(skill).mode & 0o777).toBe(0o400);
    const badSkill = launchPackage({ repository: origin });
    badSkill.agent.skills = [{ name: '../escape', version: 1, content: 'x' }];
    await expect(prepareWorkspace(home, badSkill, options)).rejects.toThrow(
      /skill name out of shape/,
    );

    const outside = launchPackage({ repository: origin });
    outside.agent.memoryDocuments = [{ path: '../repo/evil.md', version: 1, content: 'x' }];
    await expect(prepareWorkspace(home, outside, options)).rejects.toThrow(/out of shape/);
  });

  it("lists the repository's own skills in the profile's CLAUDE.md, never a linked one", async () => {
    const skills = join(origin, '.claude', 'skills');
    const write = (name: string, text: string) => {
      mkdirSync(join(skills, name), { recursive: true });
      writeFileSync(join(skills, name, 'SKILL.md'), text);
    };
    write(
      'release-notes',
      '---\nname: release-notes\ndescription: Writes the release notes.\n---\n',
    );
    write('Bad Name', '---\ndescription: Not a skill name.\n---\n');
    mkdirSync(join(skills, 'linked'));
    writeFileSync(join(dir, 'secret.md'), '---\ndescription: From outside the clone.\n---\n');
    symlinkSync(join(dir, 'secret.md'), join(skills, 'linked', 'SKILL.md'));
    git(origin, 'add', '.claude');
    git(origin, ...OWNER, 'commit', '--quiet', '-m', 'Skills');

    const launch = launchPackage({ repository: origin });
    const workspace = await prepareWorkspace(home, launch, options);
    const claudeMd = readFileSync(join(workspace.profile, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.startsWith(launch.workspace.profile.claudeMd)).toBe(true);
    expect(claudeMd).toContain(
      "## The repository's skills\n\nThe repository you work in keeps these skills for whoever works in it. When a task calls for one, read its SKILL.md first and follow it.\n\n- **release-notes** (.claude/skills/release-notes/SKILL.md): Writes the release notes.\n",
    );
    expect(claudeMd).not.toContain('Not a skill name');
    expect(claudeMd).not.toContain('From outside the clone');
  });

  it('writes no gateway config for a server that names none', async () => {
    const workspace = await prepareWorkspace(home, launchPackage({ repository: origin }), options);
    expect(workspace.mcpConfig).toBeUndefined();
    expect(existsSync(join(workspace.dir, 'mcp.json'))).toBe(false);
  });

  it('refuses a repository that is neither a URL nor an absolute path', async () => {
    for (const repository of ['../elsewhere', 'git@github.com:team/repo.git', '--upload-pack=x']) {
      await expect(prepareWorkspace(home, launchPackage({ repository }), options)).rejects.toThrow(
        'must be a URL or an absolute path',
      );
    }
  });
});

describe('branchArtifact', () => {
  it('keeps the commits of a done run in the repository they came from, as a branch of their own', async () => {
    const launch = launchPackage({ repository: origin });
    const workspace = await prepareWorkspace(home, launch, options);
    const id = launch.run.id;
    expect(await branchArtifact(workspace, id, true)).toEqual({});

    // The agent commits under its own name, not under the person's.
    const added = commit(workspace.repo, 'README.md', 'Add a README');
    expect(await branchArtifact(workspace, id, true)).toEqual({
      artifact: {
        kind: 'branch',
        ref: `agentome/${id}`,
        meta: { commits: [{ sha: added, subject: 'Add a README' }], pushedTo: origin },
      },
    });
    const kept = git(origin, 'log', '-1', '--format=%H %an <%ae>', `agentome/${id}`).trim();
    expect(kept).toBe(
      `${added} Backend developer <agent-${launch.agent.id.slice(0, 8)}@agentome.ai>`,
    );
    // The person's own branch is as it was.
    expect(git(origin, 'rev-parse', 'trunk').trim()).toBe(start);
  });

  it('keeps nothing for a run that is not done, or a repository that is not on this computer', async () => {
    const local = await prepareWorkspace(home, launchPackage({ repository: origin }), options);
    commit(local.repo, 'a.txt', 'First');
    const notDone = await branchArtifact(local, 'run-1', false);
    expect(notDone.artifact?.meta.pushedTo).toBeNull();

    const url = await prepareWorkspace(
      home,
      launchPackage({ repository: `file://${origin}` }),
      options,
    );
    expect(url.local).toBeUndefined();
    commit(url.repo, 'b.txt', 'Second');
    expect((await branchArtifact(url, 'run-2', true)).artifact?.meta.pushedTo).toBeNull();
    expect(git(origin, 'branch', '--list', 'agentome/*')).toBe('');
  });

  it('says why the commits could not be kept, and still reports them', async () => {
    const workspace = await prepareWorkspace(home, launchPackage({ repository: origin }), options);
    const added = commit(workspace.repo, 'README.md', 'Add a README');
    rmSync(origin, { recursive: true, force: true });
    const { artifact, failure } = await branchArtifact(workspace, 'run-3', true);
    expect(failure).toMatch(/^git push failed/);
    expect(artifact).toEqual({
      kind: 'branch',
      ref: 'agentome/run-3',
      meta: { commits: [{ sha: added, subject: 'Add a README' }], pushedTo: null },
    });
  });

  it('reports every commit of a new, empty repository', async () => {
    const workspace = await prepareWorkspace(home, launchPackage(), options);
    expect(workspace.base).toBeUndefined();
    const first = commit(workspace.repo, 'a.txt', 'First');
    const second = commit(workspace.repo, 'b.txt', 'Second\twith a tab');
    expect((await branchArtifact(workspace, 'run-4', true)).artifact?.meta).toEqual({
      commits: [
        { sha: second, subject: 'Second\twith a tab' },
        { sha: first, subject: 'First' },
      ],
      pushedTo: null,
    });
  });

  it('reports nothing when the agent pointed `.git` somewhere else', async () => {
    const workspace = await prepareWorkspace(home, launchPackage(), options);
    commit(workspace.repo, 'a.txt', 'First');
    const elsewhere = join(dir, 'elsewhere.git');
    execFileSync('mv', [join(workspace.repo, '.git'), elsewhere]);
    symlinkSync(elsewhere, join(workspace.repo, '.git'));
    expect(await branchArtifact(workspace, 'run-5', true)).toEqual({});
  });

  it("reads its own `.git`, whatever folder the agent's `commondir` names, and runs nothing of it", async () => {
    const workspace = await prepareWorkspace(home, launchPackage({ repository: origin }), options);
    const added = commit(workspace.repo, 'README.md', 'Add a README');
    // What a run may leave behind: HEAD as a bare commit id, and a common directory of its own
    // that lacks the commit and has a promisor remote whose upload-pack is a command.
    git(workspace.repo, 'checkout', '--quiet', '--detach');
    const planted = join(workspace.repo, 'planted');
    const ran = join(dir, 'ran');
    mkdirSync(join(planted, 'objects'), { recursive: true });
    mkdirSync(join(planted, 'refs'));
    writeFileSync(
      join(planted, 'config'),
      [
        '[core]\n\trepositoryformatversion = 1',
        '[extensions]\n\tpartialClone = planted',
        `[remote "planted"]\n\tpromisor = true\n\turl = ${origin}`,
        `\tuploadpack = "touch '${ran}';"\n`,
      ].join('\n'),
    );
    writeFileSync(join(workspace.repo, '.git', 'commondir'), `${planted}\n`);

    const { artifact } = await branchArtifact(workspace, 'run-6', false);
    expect(existsSync(ran)).toBe(false);
    expect(artifact?.meta.commits).toEqual([{ sha: added, subject: 'Add a README' }]);
  });

  it('puts its configuration back in place of a link left at `.git/config`, not through it', async () => {
    const workspace = await prepareWorkspace(home, launchPackage({ repository: origin }), options);
    const added = commit(workspace.repo, 'README.md', 'Add a README');
    const theirs = join(dir, 'theirs');
    writeFileSync(theirs, 'a file of the person\n');
    rmSync(join(workspace.repo, '.git', 'config'));
    symlinkSync(theirs, join(workspace.repo, '.git', 'config'));

    const { artifact } = await branchArtifact(workspace, 'run-7', false);
    expect(readFileSync(theirs, 'utf8')).toBe('a file of the person\n');
    expect(artifact?.meta.commits).toEqual([{ sha: added, subject: 'Add a README' }]);
  });
});

describe('removeWorkspace', () => {
  it('removes folders the agent made read-only', async () => {
    const workspace = await prepareWorkspace(home, launchPackage(), options);
    const locked = join(workspace.repo, 'locked', 'deeper');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'file'), 'x');
    chmodSync(locked, 0o500);
    chmodSync(join(workspace.repo, 'locked'), 0o500);
    removeWorkspace(workspace.dir);
    expect(existsSync(workspace.dir)).toBe(false);
  });
});

describe('the folder Claude Code keeps for a run', () => {
  it("is under the CLI's config folder, named as the CLI names it", () => {
    const repo = '/Users/someone/.agentome/runs/e6d8cca3-4d8d/repo';
    expect(cliProjectDir(repo, { HOME: '/Users/someone' })).toBe(
      '/Users/someone/.claude/projects/-Users-someone--agentome-runs-e6d8cca3-4d8d-repo',
    );
    expect(cliProjectDir(repo, { HOME: '/Users/someone', CLAUDE_CONFIG_DIR: '/cfg' })).toBe(
      '/cfg/projects/-Users-someone--agentome-runs-e6d8cca3-4d8d-repo',
    );
  });

  it("goes with the run's folder", async () => {
    const launch = launchPackage();
    const workspace = await prepareWorkspace(home, launch, options);
    const kept = cliProjectDir(workspace.repo, { HOME: dir });
    mkdirSync(join(kept, 'session', 'tool-results'), { recursive: true });
    writeFileSync(join(kept, 'session', 'tool-results', 'diff.txt'), 'the product code');
    removeRun(home, launch.run.id, { HOME: dir });
    expect(existsSync(kept)).toBe(false);
    expect(existsSync(workspace.dir)).toBe(false);
  });

  it("goes with the earlier runs' folders, and the person's own projects stay", () => {
    const env = { HOME: dir };
    const run = cliProjectDir(join(home, 'runs', 'b9b1c0de', 'repo'), env);
    const own = cliProjectDir(join(dir, 'code', 'app'), env);
    for (const folder of [run, own, join(home, 'runs', 'b9b1c0de', 'repo')]) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'kept.txt'), 'x');
    }
    removeRuns(home, env);
    expect(existsSync(run)).toBe(false);
    expect(existsSync(join(home, 'runs'))).toBe(false);
    expect(existsSync(join(own, 'kept.txt'))).toBe(true);
  });
});

describe("a computer's closed home folder", () => {
  it('opens the toolchains it has and the run, and keeps only the worker’s own folder to the file tools', () => {
    const person = realpathSync(mkdtempSync(join(tmpdir(), 'agentome-person-')));
    for (const folder of [
      '.nvm',
      '.cargo/bin',
      '.cargo/credentials',
      '.agentome/runs/r1',
      'code',
    ]) {
      mkdirSync(join(person, folder), { recursive: true });
    }
    writeFileSync(join(person, '.zsh_history'), 'export TOKEN=secret\n');
    const closed = closedHome(join(person, '.agentome'), join(person, '.agentome/runs/r1'), person);
    expect(closed.denyRead).toEqual([person]);
    expect(closed.allowRead).toEqual([
      join(person, '.agentome/runs/r1'),
      join(person, '.nvm'),
      join(person, '.cargo/bin'),
    ]);
    // Everything in the home folder but the worker's own, whose secrets are closed by name.
    expect(closed.fileDeny.sort()).toEqual(
      ['.cargo', '.nvm', '.zsh_history', 'code'].map((name) => join(person, name)),
    );
    rmSync(person, { recursive: true, force: true });
  });
});
