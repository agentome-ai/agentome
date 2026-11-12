import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';

import { RUN_CANCELLED_CODE, countedUsage } from '@agentome/shared';
import type { RunEvent, RunEventDraft, RunStatus, UsageEvent } from '@agentome/shared';

import { createStreamJsonParser } from './stream-json.js';
import type { ParserState } from './stream-json.js';
import { childOptions, cliCommand, inheritedVar, stopTree } from '../platform.js';

// Starts `claude -p` for one run and supervises it. Once a run is under way nothing throws:
// every ending is a fatal `error` event plus the outcome, whose status `foldRunStatus` agrees
// with.

/** After SIGTERM, this long until SIGKILL: a stopped run must actually stop. */
export const KILL_GRACE_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;
/** The end of stderr is what explains a failure. */
const STDERR_TAIL_CHARS = 8 * 1024;
/** How long stdout may stay open after the CLI exited: a grandchild can hold the pipe. */
const DRAIN_MS = 1_000;

/** `bypassPermissions`, `dontAsk` and `auto` remove the gate in front of the tools. */
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;
export type ClaudePermissionMode = (typeof PERMISSION_MODES)[number];

// What the CLI inherits, never the worker's whole environment: the worker holds the seat token,
// and the agent reads its own environment with `Bash`. Proxies and CAs are how it gets online;
// the sign-in is the subscription token or the config folder that holds the login.
// Names, not prefixes: a worker started from a Claude Code terminal carries that session's own
// ANTHROPIC_BASE_URL, ids and messaging token, which broke the sign-in and are not the agent's.
const INHERITED_VARS = new Set([
  ...['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'],
  ...['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy'],
  ...['no_proxy', 'all_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'],
  ...['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
]);
/** The switches of the test double (fixtures/fake-claude.mjs); the real CLI reads none. */
const FAKE_PREFIX = 'CLAUDE_FAKE_';
/** Credentials billed per request; their presence is what makes a machine `api`. */
const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
/** The subscription token `claude setup-token` writes. */
const OAUTH_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

// A failure is read from what the CLI says about itself — stderr and the diagnostics of its
// result — never from the result text, which can be the model's own words.
/** `--resume` of a session this machine does not have. */
const UNKNOWN_SESSION =
  /no conversation found with session id|unknown session|session .* not found|--resume requires a valid session|is not a valid uuid/i;
/** A stored transcript the API refuses to continue. */
const POISONED_SESSION = /diagnostics\.previous_message_id.*starts with `msg_`/i;
const NOT_AUTHENTICATED = /authentication_failed|not logged in|please run \/login|invalid api key/i;
// Signed in, but to an organization that does not let its members use a subscription in Claude
// Code: the `error` of the CLI's own message (fixtures/org-not-allowed.jsonl).
const SUBSCRIPTION_NOT_ALLOWED = /oauth_org_not_allowed/;
const RATE_LIMITED = /rate_limited|rate_limit|usage limit|\b429\b/i;

/**
 * How long an engine lets one tool call wait: a call that asks the owner waits for a person,
 * and that wait is not the run's own time (the server takes it out of the time limit), so the
 * run's limit is no bound for it. Seven days; a call that hangs without waiting for anyone is
 * still stopped by the run's own limit. Below 2^31 ms, the most a timer takes.
 */
export const OWNER_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClaudeRunLimits {
  /** Wall-clock time of the whole run, a restart in a fresh session included. */
  readonly timeoutMs: number;
  /** Turns of the agent loop, kept by the CLI itself (`--max-turns`). */
  readonly maxTurns: number;
  /** Input, output, cache read and cache write tokens added up, each API message once. */
  readonly maxTokens: number;
  /**
   * How long the run has stood waiting for its owner's answers, as the server last said in a
   * heartbeat. That time is not the run's own: the time limit moves by it.
   */
  readonly waitedMs?: () => number;
}

/**
 * Who pays. A subscription run never sees an API key; an API run gets exactly this one; a
 * gateway run gets the gateway's address and its key as a bearer token.
 */
export type ClaudeBilling =
  | { readonly mode: 'subscription' }
  | { readonly mode: 'api'; readonly apiKey: string }
  | { readonly mode: 'gateway'; readonly baseUrl: string; readonly token: string };

export interface ClaudeRunOptions {
  /** The workspace: the git worktree the agent works in. */
  readonly cwd: string;
  /** The task, written to stdin: an argument would show it in the process list. */
  readonly prompt: string;
  /** The agent's profile, outside the repository: `--add-dir` and `--settings`. */
  readonly profileDir: string;
  /** The platform's MCP servers, the only ones the run gets (`--strict-mcp-config`). */
  readonly mcpConfig?: string;
  /** `--agents`: a team run's members, whose assignments run in the foreground. */
  readonly agents?: Record<string, unknown>;
  readonly model?: string;
  /** What runs without asking; in `-p` mode nobody is there to answer a question. */
  readonly allowedTools: readonly string[];
  readonly permissionMode: ClaudePermissionMode;
  /** The session to continue; a fresh one is started when it cannot be (see `runClaude`). */
  readonly resumeSessionId?: string;
  readonly limits: ClaudeRunLimits;
  readonly billing: ClaudeBilling;
  /** `claude` from the `PATH` by default. */
  readonly cliPath?: string;
  /** The environment the child's is filtered from; `process.env` by default. */
  readonly env?: NodeJS.ProcessEnv;
}

export type ClaudeErrorCode =
  | 'invalid_options'
  | 'not_installed'
  | 'not_authenticated'
  | 'subscription_not_allowed'
  /** Codex on a computer: too old for its sandbox, or the sandbox let a command through. */
  | 'sandbox_unavailable'
  | 'rate_limited'
  | 'max_turns'
  | 'token_limit'
  | 'timeout'
  | typeof RUN_CANCELLED_CODE
  /** Any other failure: the exit code, or 128 + the number of the signal that killed it. */
  | `exit_${number}`;

export type ClaudeRunError = { readonly code: ClaudeErrorCode; readonly message: string };

export type UsageTotals = Pick<
  UsageEvent,
  'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite'
>;

export interface ClaudeRunOutcome {
  readonly status: Extract<RunStatus, 'done' | 'failed' | 'cancelled'>;
  /** The session to resume next time, when the CLI named one. */
  readonly sessionId?: string;
  /** The CLI's final text, when it printed a result. */
  readonly resultText?: string;
  readonly error?: ClaudeRunError;
  /** What the run burned, counted the way `limits.maxTokens` is. */
  readonly usage: UsageTotals;
}

/** Receives every event of the run, numbered and stamped, in order. */
export type RunEventSink = (event: RunEvent) => void;

function claudeEnvironment(env: NodeJS.ProcessEnv, billing: ClaudeBilling): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const inherited = inheritedVar(name, INHERITED_VARS) || name.startsWith(FAKE_PREFIX);
    if (inherited && value !== undefined) result[name] = value;
  }
  // A key in reach makes the CLI bill per request, not the subscription; a subscription token in
  // reach lets an API run fall back to somebody's plan. Each mode gets its own only.
  for (const name of API_KEY_VARS) delete result[name];
  if (billing.mode === 'api') {
    delete result[OAUTH_TOKEN_VAR];
    result.ANTHROPIC_API_KEY = billing.apiKey;
  }
  if (billing.mode === 'gateway') {
    delete result[OAUTH_TOKEN_VAR];
    result.ANTHROPIC_BASE_URL = billing.baseUrl;
    result.ANTHROPIC_AUTH_TOKEN = billing.token;
  }
  return result;
}

/** Why these options cannot be run, or nothing. */
function problemWith(options: ClaudeRunOptions): string | undefined {
  if (!(PERMISSION_MODES as readonly string[]).includes(options.permissionMode)) {
    return `Permission mode ${String(options.permissionMode)} is not allowed: use ${PERMISSION_MODES.join(', ')}.`;
  }
  // Above 2³¹ − 1 ms a timer fires at once, which no limit means.
  const { timeoutMs, maxTurns, maxTokens } = options.limits;
  const sane = (limit: number) => Number.isInteger(limit) && limit > 0 && limit < 2 ** 31;
  if (![timeoutMs, maxTurns, maxTokens].every(sane)) {
    return 'Every run limit must be a whole number from 1 to 2147483647.';
  }
  if (options.billing.mode === 'api' && options.billing.apiKey.trim() === '') {
    return 'A run billed to an API key needs the key.';
  }
  if (options.billing.mode === 'gateway' && options.billing.token.trim() === '') {
    return 'A run through a gateway needs its key.';
  }
  // A value that starts with `-` is a flag to the CLI, and its variadic options stop at the
  // first one: a tool list could otherwise carry `--dangerously-skip-permissions` in.
  const { profileDir, model, resumeSessionId, allowedTools } = options;
  for (const value of [profileDir, model, resumeSessionId, ...allowedTools]) {
    if (value !== undefined && (value.trim() === '' || /^-|[\n\r\0]/.test(value))) {
      return `${JSON.stringify(value)} cannot be passed to Claude Code as a value.`;
    }
  }
  if (!existsSync(join(options.profileDir, 'settings.json'))) {
    return `The agent profile ${options.profileDir} has no settings.json.`;
  }
  try {
    if (statSync(options.cwd).isDirectory()) return undefined;
  } catch {
    // `spawn` reports a missing working directory as ENOENT, like a missing binary: asked
    // here so that a run without its workspace is not reported as "not installed".
    return `The workspace ${options.cwd} does not exist.`;
  }
  return `The workspace ${options.cwd} is not a directory.`;
}

function claudeArgs(options: ClaudeRunOptions, resume: string | undefined): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  // The task's repository is an untrusted source of settings: `-p` skips the trust dialog, so
  // its `.claude/settings*.json` (hooks, `apiKeyHelper`) and `.mcp.json` would run on the
  // computer. Always, with no way to turn it off: settings come only from the profile
  // (`--settings`), MCP servers only from the platform's `--mcp-config`.
  args.push('--setting-sources', 'user', '--strict-mcp-config');
  // The transcript lives on the platform: the CLI's own copy under ~/.claude/projects would be
  // the agent's state left on the computer.
  args.push('--no-session-persistence');
  if (options.mcpConfig !== undefined) args.push('--mcp-config', options.mcpConfig);
  if (resume !== undefined) args.push('--resume', resume);
  if (options.model !== undefined) args.push('--model', options.model);
  args.push('--max-turns', String(options.limits.maxTurns));
  args.push('--permission-mode', options.permissionMode);
  if (options.allowedTools.length > 0) args.push('--allowedTools', ...options.allowedTools);
  // With the members' own words, each event under the lead's call that gave the work.
  if (options.agents !== undefined) {
    args.push('--agents', JSON.stringify(options.agents), '--forward-subagent-text');
  }
  args.push('--add-dir', options.profileDir);
  // The repository's own CLAUDE.md, .claude/CLAUDE.md and .claude/rules, as Claude Code reads
  // them for whoever works there: an --add-dir folder's instructions load without the project
  // source, whose settings and hooks the repository must not run here. Its skills are listed in
  // the profile's CLAUDE.md (workspace.ts).
  args.push('--add-dir', options.cwd);
  args.push('--settings', join(options.profileDir, 'settings.json'));
  return args;
}

function createUsageCounter() {
  // What counts is `countedUsage`'s to say, the same rule the server's ledger is written by.
  const events: UsageEvent[] = [];
  return {
    add(event: UsageEvent) {
      events.push(event);
    },
    totals(): UsageTotals {
      const all = countedUsage(events);
      const sum = (field: keyof UsageTotals) => all.reduce((total, item) => total + item[field], 0);
      const [tokensIn, tokensOut] = [sum('tokensIn'), sum('tokensOut')];
      const [tokensCacheRead, tokensCacheWrite] = [sum('tokensCacheRead'), sum('tokensCacheWrite')];
      return { tokensIn, tokensOut, tokensCacheRead, tokensCacheWrite };
    },
  };
}

const CANCELLED: ClaudeRunError = { code: RUN_CANCELLED_CODE, message: 'The run was cancelled.' };

function notInstalled(cliPath: string, cause: unknown): ClaudeRunError {
  const reason = (cause as NodeJS.ErrnoException | undefined)?.code ?? String(cause);
  const message = `Claude Code could not be started (${cliPath}: ${reason}). Install it, and make sure \`claude\` is on the PATH of the agent service.`;
  return { code: 'not_installed', message };
}

/** How the CLI process ended; `error` when it never started. */
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

/** What the CLI said about itself — the diagnostics of its lines, and stderr — to decide from. */
function cliSaid(state: ParserState, stderr: string): string {
  return [...state.diagnostics, stderr].join('\n');
}

/** How a run that ended on its own, without success, is read. */
function failure(exit: Exit, state: ParserState, stderr: string, maxTurns: number): ClaudeRunError {
  const said = cliSaid(state, stderr);
  if (state.result?.subtype === 'error_max_turns') {
    return { code: 'max_turns', message: `The run reached its limit of ${maxTurns} turns.` };
  }
  // Shown, never decided on: the CLI's stderr, or else its final text.
  const tail = (stderr.trim() || state.result?.text.trim() || '').slice(-500);
  const detail = tail === '' ? '' : ` Claude Code said: ${tail}`;
  if (SUBSCRIPTION_NOT_ALLOWED.test(said)) {
    const message = `Claude Code on this computer is signed in to an organization that does not allow subscription use in Claude Code. Run \`claude\`, sign in with your own Claude subscription and start the run again.${detail}`;
    return { code: 'subscription_not_allowed', message };
  }
  if (NOT_AUTHENTICATED.test(said)) {
    const message = `Claude Code is not signed in on this computer, or its sign-in has expired. Run \`claude\`, sign in and start the run again.${detail}`;
    return { code: 'not_authenticated', message };
  }
  if (RATE_LIMITED.test(said)) {
    const message = `The Claude account on this computer has reached its usage limit. Start the run again once the limit resets.${detail}`;
    return { code: 'rate_limited', message };
  }
  const n = exit.code ?? 128 + (exit.signal === null ? 0 : constants.signals[exit.signal]);
  const what = state.result === undefined ? 'exited without a result' : 'reported a failure';
  return { code: `exit_${n}`, message: `Claude Code ${what} (exit code ${n}).${detail}` };
}

/** `sessionFailure`: why a resumed session could not go on, when a fresh one would cure it. */
type Attempt = {
  outcome: ClaudeRunOutcome;
  sessionFailure?: 'unknown_session' | 'poisoned_session';
};

/**
 * Runs Claude Code for one run and reports everything to `sink`: the transcript, numbered from
 * 0 and stamped, then — unless the CLI reported success — one fatal `error` with the code of how
 * the run ended. Resolves once the process and its group are gone; rejects only when `sink`
 * throws, after stopping the CLI. A resumed session that cannot be continued here (another
 * computer has it, or the API refuses its transcript) is retried once in a fresh session: an
 * `unknown` event `resume_fallback` marks the place, and the failed attempt's result is left
 * out.
 */
export async function runClaude(
  options: ClaudeRunOptions,
  sink: RunEventSink,
  signal: AbortSignal,
): Promise<ClaudeRunOutcome> {
  let seq = 0;
  let sinkError: { readonly cause: unknown } | undefined;
  /** Numbers, stamps and delivers an event, and returns it; nothing once the sink has failed. */
  const emit = (draft: RunEventDraft): RunEvent | undefined => {
    if (sinkError) return undefined;
    try {
      const event: RunEvent = { ...draft, seq: seq++, at: new Date().toISOString() };
      sink(event);
      return event;
    } catch (cause) {
      // Thrown inside a stream callback it would take the worker down and leave the CLI
      // running; instead the run is stopped, and the error is the caller's once it has.
      sinkError = { cause };
      return undefined;
    }
  };
  const settle = (outcome: ClaudeRunOutcome): ClaudeRunOutcome => {
    if (sinkError) throw sinkError.cause;
    return outcome;
  };
  const usage = createUsageCounter();
  const deadline = Date.now() + options.limits.timeoutMs;
  const cliPath = options.cliPath ?? 'claude';

  /** One invocation of the CLI, from spawn to the last event. */
  async function attempt(resume: string | undefined): Promise<Attempt> {
    const parser = createStreamJsonParser();
    // A resumed attempt may still be retried in a fresh session; until that is decided, its
    // failed result must not end the run in the transcript.
    const deferred: RunEventDraft[] = [];
    let stderr = '';
    /** The run's own ending — a limit, a cancel — when it came before the CLI's result. */
    let ended: ClaudeRunError | undefined;
    // Not `parser.state.result`: the parser reads a whole chunk before its events are handled,
    // and whether a limit counts must not depend on where stdout happened to be cut.
    let resulted = false;
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;

    const outcome = (error?: ClaudeRunError): ClaudeRunOutcome => ({
      status: !error ? 'done' : error.code === RUN_CANCELLED_CODE ? 'cancelled' : 'failed',
      sessionId: parser.state.sessionId,
      resultText: parser.state.result?.text,
      error,
      usage: usage.totals(),
    });
    const fail = (error: ClaudeRunError): Attempt => {
      emit({ type: 'error', ...error, fatal: true });
      return { outcome: outcome(error) };
    };

    if (signal.aborted) return fail(CANCELLED);
    let child: ChildProcess;
    try {
      const [file, ...first] = cliCommand(cliPath, options.env ?? process.env);
      child = spawn(file, [...first, ...claudeArgs(options, resume)], {
        cwd: options.cwd,
        env: {
          ...claudeEnvironment(options.env ?? process.env, options.billing),
          // The CLI reads the CLAUDE.md of an `--add-dir` folder only with this, and the
          // profile's CLAUDE.md holds the agent's instructions.
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          // A call that waits for the owner's approval outlasts the run's time limit: the CLI
          // would cut it at its own default. Milliseconds; progress does not extend it (CLI
          // 2.1.280).
          MCP_TOOL_TIMEOUT: String(OWNER_WAIT_MS),
          // The agent's memory is on the platform (memory_write); the CLI's own would stay on
          // the computer, out of the owner's sight.
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          // A team member's assignment returns its report, so the team hook knows it reported;
          // in the background the lead would learn of it later, and the hook not at all.
          ...(options.agents ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } : {}),
        },
        stdio: 'pipe',
        // Its own process group, so that a stop reaches what the CLI started (an MCP server, a
        // test runner). The price: a worker killed outright leaves the CLI to the server's reaper.
        ...childOptions(),
      });
    } catch (cause) {
      return fail(notInstalled(cliPath, cause));
    }

    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      stopTree(child, 'SIGTERM');
      // A CLI that ignores SIGTERM, or is stuck in a tool that does, must still let the run end.
      killTimer = setTimeout(() => stopTree(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    // The run's own ending goes into the transcript at once, ahead of whatever the dying CLI
    // still prints — unless the CLI has already said how it ended.
    const end = (error: ClaudeRunError): void => {
      if (!ended && !resulted) {
        ended = error;
        emit({ type: 'error', ...error, fatal: true });
      }
      stop();
    };

    const handle = (draft: RunEventDraft): void => {
      if (draft.type === 'result') resulted = true;
      if (draft.type === 'result' && draft.isError && resume !== undefined && !ended) {
        deferred.push(draft);
        return;
      }
      const event = emit(draft);
      if (!event) return stop();
      if (event.type !== 'usage') return;
      usage.add(event);
      // The totals come with the result, when the run is over: nothing is left to stop, and a
      // finished run must not end as over its limit because the turns undercounted.
      if (event.total) return;
      const used = Object.values(usage.totals()).reduce((sum, tokens) => sum + tokens, 0);
      const limit = options.limits.maxTokens;
      const message = `The run used ${used} tokens, more than its limit of ${limit}, and was stopped.`;
      if (used > limit) end({ code: 'token_limit', message });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const draft of parser.push(chunk)) handle(draft);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      stderr = (stderr + text).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      // EPIPE: the CLI exited before reading its prompt, and its exit says why. Anything else
      // goes into the error message, since the CLI then ran without its task.
      if (error.code !== 'EPIPE') stderr += `\nThe prompt could not be written: ${error.message}`;
    });
    child.stdin?.end(options.prompt);

    const ms = options.limits.timeoutMs;
    const allowed = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`;
    const message = `The run exceeded its time limit of ${allowed} and was stopped.`;
    // Looked at again when it fires: the run may have waited for its owner since, and the
    // deadline is that much later.
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      const left = deadline + (options.limits.waitedMs?.() ?? 0) - Date.now();
      timer = setTimeout(
        left > 0 ? arm : () => end({ code: 'timeout', message }),
        Math.max(0, left),
      );
    };
    arm();
    const onAbort = (): void => end(CANCELLED);
    signal.addEventListener('abort', onAbort, { once: true });

    const exit = await new Promise<Exit>((resolve) => {
      let drain: NodeJS.Timeout | undefined;
      child.on('error', (error) => {
        // Only a process that never started ends here; a signal that missed is not news.
        if (child.pid === undefined) resolve({ code: null, signal: null, error });
      });
      child.once('exit', () => {
        // A grandchild that inherited stdout keeps the pipe open after the CLI is gone.
        drain = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, DRAIN_MS);
      });
      child.once('close', (code, closeSignal) => {
        clearTimeout(drain);
        resolve({ code, signal: closeSignal });
      });
    });

    for (const draft of parser.end()) handle(draft);
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal.removeEventListener('abort', onAbort);
    // Whatever the CLI left behind in its group — a dev server, a watcher — goes with it: the
    // run is over and its workspace is about to be removed.
    stopTree(child, 'SIGKILL');

    if (ended) return { outcome: outcome(ended) };
    if (exit.error) return fail(notInstalled(cliPath, exit.error));
    // A result that says success is the run's ending, whatever the exit code that follows it.
    if (parser.state.result?.isError === false) return { outcome: outcome() };

    const error = failure(exit, parser.state, stderr, options.limits.maxTurns);
    const said = cliSaid(parser.state, stderr);
    const lost = POISONED_SESSION.test(said)
      ? 'poisoned_session'
      : UNKNOWN_SESSION.test(said)
        ? 'unknown_session'
        : undefined;
    // Only a session that failed before its first turn is started afresh: one that did work
    // would repeat it, commits and tool calls included.
    const untouched = parser.state.turnUsage === 0 && !signal.aborted;
    if (resume !== undefined && untouched && lost !== undefined) {
      return { outcome: outcome(error), sessionFailure: lost };
    }
    for (const draft of deferred) emit(draft);
    return fail(error);
  }

  const problem = problemWith(options);
  if (problem !== undefined) {
    const error: ClaudeRunError = { code: 'invalid_options', message: problem };
    emit({ type: 'error', ...error, fatal: true });
    return settle({ status: 'failed', error, usage: usage.totals() });
  }
  const first = await attempt(options.resumeSessionId);
  if (first.sessionFailure === undefined || sinkError) return settle(first.outcome);
  const raw = { reason: first.sessionFailure, sessionId: options.resumeSessionId };
  emit({ type: 'unknown', rawType: 'resume_fallback', raw });
  return settle((await attempt(undefined)).outcome);
}

export interface ClaudeProbe {
  readonly installed: boolean;
  readonly version?: string;
  /** Who would pay, by the credentials of this machine: `api` with a key, else `subscription`. */
  readonly billing: 'subscription' | 'api';
}

/**
 * Can this computer run Claude Code, and who would pay? Never throws: "not installed" is an
 * answer. The sign-in is not checked here: `claude auth status` has reported a healthy login
 * whose first request then failed (2.1.90), and the only real check is a paid request. Its "no"
 * is believed, by `claudeSignedOut`.
 */
export async function probe(
  options: { readonly cliPath?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeProbe> {
  const env = options.env ?? process.env;
  const hasKey = API_KEY_VARS.some((name) => (env[name] ?? '').trim() !== '');
  const billing = hasKey ? 'api' : 'subscription';
  const childEnv = claudeEnvironment(env, { mode: 'subscription' });
  const settings = {
    env: childEnv,
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL' as const,
    windowsHide: true,
  };
  const [file, ...first] = cliCommand(options.cliPath ?? 'claude', env);
  const output = await new Promise<string | undefined>((resolve) => {
    try {
      execFile(file, [...first, '--version'], settings, (error, stdout) => {
        resolve(error === null ? stdout : undefined);
      });
    } catch {
      // A path `execFile` refuses outright is not an installed CLI either.
      resolve(undefined);
    }
  });
  if (output === undefined) return { installed: false, billing };
  return { installed: true, version: /\b\d+\.\d+\.\d+\b/.exec(output)?.[0], billing };
}

/**
 * Whether Claude Code says it is signed out on this computer. Only that "no" is believed:
 * a CLI that says yes, says nothing or does not answer counts as signed in, and a sign-in that
 * turns out refused is told by the run it fails.
 */
export async function claudeSignedOut(
  options: { readonly cliPath?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const env = claudeEnvironment(options.env ?? process.env, { mode: 'subscription' });
  // A token from `claude setup-token` is the sign-in: what `auth status` makes of it is not asked.
  if ((env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim() !== '') return false;
  const settings = { env, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' as const };
  const [file, ...first] = cliCommand(options.cliPath ?? 'claude', env);
  const output = await new Promise<string>((resolve) => {
    try {
      // It exits 1 when signed out: what it printed is read whatever its exit code.
      const args = [...first, 'auth', 'status'];
      const child = execFile(file, args, { ...settings, windowsHide: true }, (_, out) =>
        resolve(out),
      );
      child.stdin?.end();
    } catch {
      resolve('');
    }
  });
  return /"loggedIn":\s*false/.test(output);
}
