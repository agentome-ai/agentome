import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe } from '../config.js';

// The hooks of a team run, which the CLI starts as `agentome-worker team-hook <dir>`:
// the lead gives work only to its team, in a manual team only to the agents of the open step and
// the steps before it, and Agentome approves each step before it starts. In auto the lead's first
// assignments go ahead and the work after them waits for one approval, once per task.
// Assignments run in the foreground (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS), so an agent has
// reported once its Agent call returns. A refusal is the lead's to read: it says what to do.

/** What the worker writes in `<run>/team/` for the hook; the agent may not write there. */
export interface TeamHookConfig {
  mode: 'auto' | 'manual';
  keys: string[];
  steps: string[][];
  /** `/mcp/team-step`, opened by the lead's token from the gateway's config. */
  stepUrl: string;
  mcpConfig: string;
}

type State = { reported: string[]; approved: number[]; gate?: boolean };
type Decision = { deny: string } | undefined;
type Ask = (
  step: number | null,
  members: string[],
  description: string,
  gate?: boolean,
) => Promise<Decision>;

const MEMBER_TOOL = /^mcp__agentome-([a-z0-9-]+)__/;

export const teamDir = (runDir: string) => join(runDir, 'team');

/** The CLI's hook input on stdin → its output on stdout; any failure refuses. */
export async function teamHookMain(runDir: string | undefined): Promise<number> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  let decision: Decision;
  try {
    if (runDir === undefined) throw new Error('No run folder was given');
    decision = await decide(runDir, JSON.parse(input) as HookInput);
  } catch (error) {
    decision = { deny: `Agentome could not check this call: ${describe(error)}` };
  }
  if (decision) {
    const output = { hookEventName: 'PreToolUse', permissionDecision: 'deny' };
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { ...output, permissionDecisionReason: decision.deny },
      }),
    );
  }
  return 0;
}

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  agent_type?: string;
  tool_input?: { subagent_type?: string; description?: string };
}

export async function decide(runDir: string, input: HookInput, ask?: Ask): Promise<Decision> {
  const dir = teamDir(runDir);
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as TeamHookConfig;
  const tool = input.tool_name ?? '';
  const member = MEMBER_TOOL.exec(tool)?.[1];
  if (member !== undefined) {
    // A member's tools act as that member: only its own subagent calls them.
    return input.agent_type === member
      ? undefined
      : { deny: `That tool acts as ${member}: give ${member} the work instead.` };
  }
  // `Task` is the tool's older name, which the CLI still writes in places (permission_denials).
  if (tool !== 'Agent' && tool !== 'Task') return undefined;
  const key = input.tool_input?.subagent_type ?? '';
  if (input.hook_event_name === 'PostToolUse') {
    if (config.keys.includes(key)) {
      await locked(dir, (state) => {
        if (!state.reported.includes(key)) state.reported.push(key);
      });
    }
    return undefined;
  }
  if (!config.keys.includes(key)) {
    return { deny: `Only your team works on this run: ${config.keys.join(', ')}.` };
  }
  const description = input.tool_input?.description ?? '';
  const approve = ask ?? askServer(config);
  if (config.mode === 'auto') {
    return locked(dir, async (state) => {
      // Once a member has reported (the analysis, say), the next work asks once; the
      // assignments of that message wait on the same answer, as the lock holds them.
      const gate = state.reported.length > 0 && !state.gate;
      const decision = await approve(null, [key], description, gate);
      if (gate && !decision) state.gate = true;
      return decision;
    });
  }
  return locked(dir, async (state) => {
    const open = config.steps.findIndex((step) => step.some((k) => !state.reported.includes(k)));
    const current = open === -1 ? config.steps.length : open;
    if (current < config.steps.length && config.steps[current]?.includes(key)) {
      if (state.approved.includes(current)) return undefined;
      const decision = await approve(current + 1, config.steps[current] ?? [], description);
      if (!decision) state.approved.push(current);
      return decision;
    }
    if (config.steps.slice(0, current).some((step) => step.includes(key))) return undefined;
    const at = config.steps.findIndex((step) => step.includes(key)) + 1;
    const waiting = config.steps[current]?.filter((k) => !state.reported.includes(k)) ?? [];
    return {
      deny: `${key} works in step ${at}. Step ${current + 1} is open until ${waiting.join(', ')} report; give them their work first.`,
    };
  });
}

/** One hook at a time reads and writes the state: assignments of one message run together. */
async function locked<T>(dir: string, body: (state: State) => T | Promise<T>): Promise<T> {
  const lock = join(dir, 'lock');
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!alive(lock)) rmSync(lock, { recursive: true, force: true });
      else await sleep(100);
    }
  }
  try {
    const file = join(dir, 'state.json');
    let state: State = { reported: [], approved: [] };
    try {
      state = JSON.parse(readFileSync(file, 'utf8')) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await body(state);
    writeFileSync(file, JSON.stringify(state));
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Whether the hook holding the lock still runs: the CLI kills one that outlives its timeout. */
function alive(lock: string): boolean {
  try {
    process.kill(Number(readFileSync(join(lock, 'pid'), 'utf8')), 0);
    return true;
  } catch (error) {
    // A lock without its pid yet is being taken right now.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Asks the gateway, which waits for the owner when the lead's policy is ask. */
function askServer(config: TeamHookConfig): Ask {
  return async (step, members, description, gate = false) => {
    const mcp = JSON.parse(readFileSync(config.mcpConfig, 'utf8')) as {
      mcpServers: { agentome: { headers: { Authorization: string } } };
    };
    const response = await fetch(config.stepUrl, {
      method: 'POST',
      headers: {
        authorization: mcp.mcpServers.agentome.headers.Authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ step, members, description: description.slice(0, 500), gate }),
    });
    if (!response.ok) throw new Error(`Agentome answered ${response.status}`);
    const answer = (await response.json()) as { allowed: boolean; reason: string };
    return answer.allowed ? undefined : { deny: answer.reason || 'Your owner turned this down.' };
  };
}
