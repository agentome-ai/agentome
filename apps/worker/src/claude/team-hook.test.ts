import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decide, type TeamHookConfig } from './team-hook.js';

let run: string;

function setUp(config: Partial<TeamHookConfig>) {
  const team = join(run, 'team');
  mkdirSync(team);
  const full: TeamHookConfig = {
    mode: 'manual',
    keys: ['po', 'backend', 'frontend', 'qa'],
    steps: [['po'], ['backend', 'frontend'], ['qa']],
    stepUrl: 'https://agentome.test/mcp/team-step',
    mcpConfig: join(run, 'mcp.json'),
    ...config,
  };
  writeFileSync(join(team, 'config.json'), JSON.stringify(full));
}

const assign = (key: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { subagent_type: key, description: `Work for ${key}` },
});
const reported = (key: string) => ({ ...assign(key), hook_event_name: 'PostToolUse' });

beforeEach(() => {
  run = mkdtempSync(join(tmpdir(), 'agentome-team-hook-'));
});
afterEach(() => rmSync(run, { recursive: true, force: true }));

describe('the team hook', () => {
  it('lets the lead call only its team, and a member tool only its own subagent', async () => {
    setUp({ mode: 'auto' });
    const ask = vi.fn(async () => undefined);
    expect(await decide(run, assign('general-purpose'), ask)).toEqual({
      deny: 'Only your team works on this run: po, backend, frontend, qa.',
    });
    const tool = { hook_event_name: 'PreToolUse', tool_name: 'mcp__agentome-qa__memory_write' };
    expect(await decide(run, tool, ask)).toEqual({
      deny: 'That tool acts as qa: give qa the work instead.',
    });
    expect(await decide(run, { ...tool, agent_type: 'backend' }, ask)).toBeDefined();
    expect(await decide(run, { ...tool, agent_type: 'qa' }, ask)).toBeUndefined();
    expect(await decide(run, { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, ask)).toBe(
      undefined,
    );
    expect(await decide(run, { ...assign('Explore'), tool_name: 'Task' }, ask)).toBeDefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks Agentome about every assignment in auto, and passes on its answer', async () => {
    setUp({ mode: 'auto' });
    const ask = vi.fn(async () => ({ deny: 'Your owner turned this down.' }));
    expect(await decide(run, assign('qa'), ask)).toEqual({ deny: 'Your owner turned this down.' });
    expect(ask).toHaveBeenCalledWith(null, ['qa'], 'Work for qa', false);
  });

  it('marks the first work after a report in auto as the gate, once', async () => {
    setUp({ mode: 'auto' });
    const ask = vi.fn(async () => undefined);
    // The first assignments, before anyone reported: not the gate.
    await decide(run, assign('po'), ask);
    expect(ask).toHaveBeenLastCalledWith(null, ['po'], 'Work for po', false);
    await decide(run, reported('po'), ask);
    // The work after the analysis: the gate, asked once.
    await decide(run, assign('backend'), ask);
    expect(ask).toHaveBeenLastCalledWith(null, ['backend'], 'Work for backend', true);
    await decide(run, assign('qa'), ask);
    expect(ask).toHaveBeenLastCalledWith(null, ['qa'], 'Work for qa', false);
  });

  it('keeps the gate closed in auto when the owner turns it down', async () => {
    setUp({ mode: 'auto' });
    const ask = vi.fn<() => Promise<{ deny: string } | undefined>>(async () => undefined);
    await decide(run, assign('po'), ask);
    await decide(run, reported('po'), ask);
    ask.mockResolvedValueOnce({ deny: 'Not yet.' });
    expect(await decide(run, assign('backend'), ask)).toEqual({ deny: 'Not yet.' });
    // Asked again next time: a refusal does not open the gate.
    await decide(run, assign('backend'), ask);
    expect(ask).toHaveBeenLastCalledWith(null, ['backend'], 'Work for backend', true);
  });

  it('holds a manual team to its steps, with one approval a step', async () => {
    setUp({});
    const ask = vi.fn<(step: number | null, members: string[]) => Promise<undefined>>(
      async () => undefined,
    );
    expect(await decide(run, assign('po'), ask)).toBeUndefined();
    expect(ask).toHaveBeenLastCalledWith(1, ['po'], 'Work for po');
    expect(await decide(run, assign('backend'), ask)).toEqual({
      deny: 'backend works in step 2. Step 1 is open until po report; give them their work first.',
    });
    await decide(run, reported('po'), ask);

    // Two assignments of one message: the second waits for the first's approval and needs none.
    const both = await Promise.all([
      decide(run, assign('backend'), ask),
      decide(run, assign('frontend'), ask),
    ]);
    expect(both).toEqual([undefined, undefined]);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenLastCalledWith(2, ['backend', 'frontend'], expect.any(String));
    await decide(run, reported('backend'), ask);
    expect(await decide(run, assign('qa'), ask)).toBeDefined();
    await decide(run, reported('frontend'), ask);

    // Work sent back to an earlier step needs no approval; the next step does.
    expect(await decide(run, assign('po'), ask)).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(await decide(run, assign('qa'), ask)).toBeUndefined();
    expect(ask).toHaveBeenLastCalledWith(3, ['qa'], 'Work for qa');
  });

  it('asks again after the owner turned a step down', async () => {
    setUp({});
    const ask = vi
      .fn<(step: number | null) => Promise<{ deny: string } | undefined>>()
      .mockResolvedValueOnce({ deny: 'Not yet: the spec comes first.' })
      .mockResolvedValueOnce(undefined);
    expect(await decide(run, assign('po'), ask)).toEqual({
      deny: 'Not yet: the spec comes first.',
    });
    expect(await decide(run, assign('po'), ask)).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('takes over the lock of a hook the CLI killed', async () => {
    setUp({ mode: 'auto' });
    const lock = join(run, 'team', 'lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), '999999');
    expect(await decide(run, reported('qa'))).toBeUndefined();
  });
});
