import type { agents, tasks } from '@agentome/db';
import { describe, expect, it } from 'vitest';
import { LaunchPackage } from '../protocol.js';
import { buildLaunchPackage, profileFor, projectMd, runLimits } from './launch.js';

const defaults = { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 };

const agent: typeof agents.$inferSelect = {
  id: '7f3a9c21-0000-4000-8000-000000000001',
  ownerUserId: '7f3a9c21-0000-4000-8000-000000000002',
  name: 'Backend developer',
  roleTitle: 'Senior backend engineer, Payments',
  instructions: '  Reproduce a bug with a failing test first, then fix it.\n',
  engine: 'claude-code',
  modelPref: 'sonnet',
  runsOn: 'laptop',
  modelConnectionId: null,
  serverShell: false,
  budgetResumedAt: null,
  skills: [],
  tools: [],
  budget: { maxTurns: 80 },
  status: 'active',
  copiedFromAgentId: null,
  templateId: null,
  createdAt: new Date('2026-10-21T10:00:00Z'),
};

const task: typeof tasks.$inferSelect = {
  id: '7f3a9c21-0000-4000-8000-000000000003',
  agentId: agent.id,
  projectId: null,
  parentTaskId: null,
  title: 'Add a README',
  body: 'Describe how to run the tests.',
  source: 'manual',
  externalRef: null,
  externalError: null,
  repository: '/Users/maria/code/payments-api',
  status: 'open',
  createdBy: agent.ownerUserId,
  createdAt: new Date('2026-10-21T10:05:00Z'),
};

const build = (overrides: Partial<typeof agent> = {}) =>
  buildLaunchPackage({
    run: { id: '7f3a9c21-0000-4000-8000-000000000004', limits: defaults },
    token: 'run-token',
    agent: { ...agent, ...overrides },
    task,
    publicUrl: 'https://agentome.example.com:8443/',
  });

describe('buildLaunchPackage', () => {
  it('carries the run, the agent and the task as the protocol describes them', () => {
    const launch = build();
    expect(LaunchPackage.parse(launch)).toEqual(launch);
    expect(launch.run).toEqual({ id: launch.run.id, token: 'run-token', limits: defaults });
    expect(launch.agent).toMatchObject({ name: 'Backend developer', modelPref: 'sonnet' });
    expect(launch.agent.skills).toEqual([]);
    expect(launch.agent.memoryDocuments).toEqual([]);
    expect(launch.task).toEqual({
      id: task.id,
      title: 'Add a README',
      body: 'Describe how to run the tests.',
      repository: '/Users/maria/code/payments-api',
    });
  });

  it('writes CLAUDE.md from the role and the instructions', () => {
    const { claudeMd } = build().workspace.profile;
    expect(claudeMd).toMatch(/^# Backend developer\n/);
    expect(claudeMd).toContain(
      'You are Backend developer, Senior backend engineer, Payments, an agent of this company',
    );
    expect(claudeMd).toContain(
      '## Instructions\n\nReproduce a bug with a failing test first, then fix it.\n\n## Workspace',
    );
    expect(claudeMd).toContain('It is deleted when the run ends');
    expect(claudeMd).toContain('open a change request with the code_host_open_change_request tool');
  });

  it('does not leave the instructions or the role blank', () => {
    const { claudeMd } = build({ roleTitle: ' ', instructions: '' }).workspace.profile;
    expect(claudeMd).toContain('You are Backend developer, an agent');
    expect(claudeMd).toContain('Your owner has not written instructions yet.');
  });

  it('confines the agent: workspace edits, sandboxed shell, the platform as the only host', () => {
    const { settings } = build().workspace.profile;
    expect(settings.permissionMode).toBe('acceptEdits');
    expect(settings.allowedTools).not.toContain('Edit');
    expect(settings.allowedTools).not.toContain('WebFetch');
    expect(settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // A hostname: Claude Code's sandbox matches no port.
      network: { allowedDomains: ['agentome.example.com'], strictAllowlist: true },
    });
  });

  it('lets the agent reach a server on its own computer, and only that one', () => {
    for (const url of ['http://localhost:3100', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      const { network } = profileFor({ name: 'A', roleTitle: '', instructions: '' }, url).settings
        .sandbox;
      expect(network.allowedDomains).toEqual([new URL(url).hostname]);
      expect(network.allowLocalBinding).toBe(true);
    }
    // Local binding reaches loopback only: a server at a private IP needs a hostname instead.
    for (const url of ['https://a.corp', 'https://192.168.1.233']) {
      const remote = profileFor({ name: 'A', roleTitle: '', instructions: '' }, url).settings
        .sandbox.network;
      expect(remote.allowLocalBinding).toBeUndefined();
    }
  });

  it('gives a server run no shell and no sandbox, unless an admin allowed a shell', () => {
    const plain = { name: 'A', roleTitle: '', instructions: '' };
    const server = profileFor(plain, 'https://a.corp', true);
    expect(server.settings.allowedTools).not.toContain('Bash');
    expect(server.settings.allowedTools).toContain('mcp__agentome');
    expect(server.settings.sandbox.enabled).toBe(false);
    expect(server.claudeMd).toContain('You have no shell here');
    const shell = profileFor({ ...plain, serverShell: true }, 'https://a.corp', true);
    expect(shell.settings.allowedTools).toContain('Bash');
    expect(shell.claudeMd).toContain("this run's own container");
    // On a computer the switch means nothing: the sandbox holds the shell there.
    const laptop = profileFor({ ...plain, serverShell: false }, 'https://a.corp');
    expect(laptop.settings.allowedTools).toContain('Bash');
    expect(laptop.settings.sandbox.enabled).toBe(true);
    expect(laptop.claudeMd).not.toContain('On the server');
  });

  it('has the agent keep its plan with the task tools the run page reads', () => {
    const { claudeMd } = profileFor(
      { name: 'A', roleTitle: '', instructions: '' },
      'https://a.corp',
    );
    expect(claudeMd).toContain('TaskCreate');
    expect(claudeMd).toContain('SendMessage finds no transcript');
  });
});

describe('runLimits', () => {
  it('takes the platform defaults where the budget sets nothing', () => {
    expect(runLimits(defaults, null)).toEqual(defaults);
    expect(runLimits(defaults, { usd: 100, period: 'month' })).toEqual(defaults);
  });

  it('lets the budget override each limit, and ignores values that are not limits', () => {
    expect(runLimits(defaults, { maxMinutes: 15, maxTurns: 80 })).toEqual({
      ...defaults,
      maxMinutes: 15,
      maxTurns: 80,
    });
    expect(runLimits(defaults, { maxTokens: -5, maxTurns: '10', maxMinutes: 1.5 })).toEqual(
      defaults,
    );
    expect(runLimits(defaults, 'nonsense')).toEqual(defaults);
  });
});

describe('projectMd', () => {
  const project = { description: '', goals: '', repositories: [] };

  it('writes the project in its own words, and cuts what a run should not carry', () => {
    expect(
      projectMd({
        ...project,
        name: 'Payments',
        description: 'Card and bank payouts.',
        goals: '- Zero lost payouts',
      }),
    ).toBe('# Payments\n\nCard and bank payouts.\n\n## Goals\n\n- Zero lost payouts\n');
    expect(projectMd({ ...project, name: 'Docs' })).toBe('# Docs\n');
    const long = projectMd({ ...project, name: 'Big', description: 'x'.repeat(30_000) });
    expect(long.length).toBeLessThan(20_200);
    expect(long).toMatch(
      /Cut here: the project's description and goals are longer than a run takes\.\)\n$/,
    );
  });

  it('lists the repositories, the main one first, past any cut', () => {
    const repositories = ['https://github.com/acme/api', 'https://github.com/acme/web'];
    expect(projectMd({ ...project, name: 'Payments', repositories })).toBe(
      '# Payments\n\n## Repositories\n\n- https://github.com/acme/api (main)\n- https://github.com/acme/web\n',
    );
    const long = projectMd({
      ...project,
      name: 'Big',
      description: 'x'.repeat(30_000),
      repositories,
    });
    expect(long).toMatch(
      /longer than a run takes\.\)\n\n## Repositories\n\n- https:\/\/github\.com\/acme\/api \(main\)/,
    );
  });
});
