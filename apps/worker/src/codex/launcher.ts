import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { RUN_CANCELLED_CODE, type RunEvent, type RunEventDraft } from '@agentome/shared';

import { OWNER_WAIT_MS } from '../claude/launcher.js';
import type { ClaudeRunError, ClaudeRunOutcome, RunEventSink } from '../claude/launcher.js';
import { childOptions, cliCommand, inheritedVar, stopTree } from '../platform.js';

// Starts `codex exec --json` for one run and turns its JSONL into run events, as the
// claude launcher does for stream-json. Checked against codex-cli 0.163.0: the person's
// config.toml is ignored and everything comes as -c overrides, so that only the platform's MCP
// server and instructions reach the run, while a computer keeps its ChatGPT sign-in in CODEX_HOME.
//
// On a computer the agent's commands run in Codex's own sandbox, set by a permissions profile:
// they read the system's minimum, the folders tools live in and what the run names;
// they write the clone and the temporary folder; they reach the platform's hosts through
// Codex's proxy and nothing else. The person's home is closed whole, their keys with it, and
// Codex's own sign-in, which the CLI reads outside the sandbox. Codex calls the profiles beta
// and the proxy experimental, so no run starts before `sandboxRefusal` has seen them hold.

const KILL_GRACE_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;
const STDERR_TAIL_CHARS = 8 * 1024;
/** A tool's output in the transcript: for reading, not a copy of everything it printed. */
const OUTPUT_CHARS = 4_000;

// What the CLI inherits: never the worker's environment, which holds the seat token. CODEX_HOME
// is where a computer's sign-in lives.
const INHERITED_VARS = new Set([
  ...['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'],
  ...['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy'],
  ...['no_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY'],
  ...['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'],
  'CODEX_HOME',
]);
/** The test double's switches (fixtures/fake-codex.mjs); the real CLI reads none. */
const FAKE_PREFIX = 'CODEX_FAKE_';
const RUN_TOKEN_VAR = 'AGENTOME_RUN_TOKEN';
const MODEL_KEY_VAR = 'AGENTOME_MODEL_KEY';
const PROFILE = 'agentome';
/** The first version the computer's sandbox was checked against. */
const LAPTOP_MIN = [0, 163, 0] as const;
/** Where a computer keeps what an agent runs, git, node and compilers, outside its owner's home. */
const TOOL_ROOTS = ['/opt/homebrew', '/usr/local', '/Library/Developer', '/Applications/Xcode.app'];

const NOT_AUTHENTICATED = /\b401\b|unauthorized|not logged in|codex login|invalid api key/i;
const RATE_LIMITED = /\b429\b|rate.?limit|usage limit|quota/i;

/** A computer's ChatGPT sign-in, or a server seat's model connection as an OpenAI-format provider. */
export type CodexBilling =
  | { readonly mode: 'subscription' }
  | { readonly mode: 'provider'; readonly baseUrl: string; readonly key: string };

/** What a computer's sandbox opens beside the clone and the tools. */
export interface CodexSandbox {
  /** Folders and files to read: the agent's profile, the git proxy's password. */
  readonly readable: readonly string[];
  /** The platform's own hosts, where the agent's git pushes. */
  readonly hosts: readonly string[];
}

export interface CodexRunOptions {
  readonly cwd: string;
  readonly prompt: string;
  /** The profile's text: the agent's instructions, as the developer message of the run. */
  readonly instructions: string;
  readonly mcp?: { readonly url: string; readonly token: string };
  readonly model?: string;
  /** A server agent without a shell works with its MCP tools only. */
  readonly shell: boolean;
  /** On a server seat the run's container is the sandbox; on a computer, Codex's own. */
  readonly server: boolean;
  /** A computer's; without one nothing is open but the clone and the tools. */
  readonly sandbox?: CodexSandbox;
  /**
   * A Windows computer, whose admin allowed it to run the agent's commands without a sandbox:
   * Codex there runs them with the person's own access, as on a server seat.
   */
  readonly unsandboxed?: boolean;
  /** `waitedMs`: how long the run stood waiting for its owner, by which the time limit moves. */
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxTokens: number;
    readonly waitedMs?: () => number;
  };
  readonly billing: CodexBilling;
  readonly cliPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** A TOML value for `-c`: a JSON string is a valid TOML basic string. */
const toml = (value: string) => JSON.stringify(value);
/** A TOML inline table of values that are TOML already. */
const table = (entries: (readonly [string, string])[]) =>
  `{ ${entries.map(([key, value]) => `${toml(key)} = ${value}`).join(', ')} }`;

/**
 * The tools' folders on this computer, and the Node that runs the worker, wherever it is. A
 * Node outside the person's home opens its own folder, the way a version manager lays one out.
 * A Node inside the home opens itself and its modules and no more: the folder it is in may be
 * ~/.local or ~/Library, which hold far more than Node.
 */
export function nodeRoots(execPath: string, home: string): string[] {
  const within = (inner: string, outer: string) => `${inner}/`.startsWith(`${outer}/`);
  const node = dirname(dirname(execPath));
  return node === '/' || within(home, node) || within(node, home)
    ? [execPath, join(node, 'lib', 'node_modules')]
    : [node];
}

function toolRoots(): string[] {
  const roots = [...TOOL_ROOTS, ...nodeRoots(process.execPath, homedir())];
  return [...new Set(roots)].filter((root) => existsSync(root));
}

/**
 * A computer's sandbox as `-c` overrides, for `codex exec` and for `codex sandbox` alike. `.git`
 * is named because Codex keeps it read-only inside a writable folder, and the agent commits;
 * what it writes there the worker's own git never runs (workspace.ts). A host is reached
 * through the proxy only: Codex refuses every direct connection while the proxy is on.
 */
export function sandboxConfig(sandbox: CodexSandbox, roots = toolRoots()): [string, string][] {
  const read = toml('read');
  const write = toml('write');
  const filesystem = table([
    [':minimal', read],
    [':tmpdir', write],
    ...[...roots, ...sandbox.readable].map((path) => [path, read] as const),
    [
      ':workspace_roots',
      table([
        ['.', write],
        ['.git', write],
      ]),
    ],
  ]);
  const domains = table(sandbox.hosts.map((host) => [host, toml('allow')] as const));
  return [
    ['default_permissions', toml(PROFILE)],
    ['features.network_proxy', 'true'],
    [
      `permissions.${PROFILE}`,
      `{ filesystem = ${filesystem}, network = { enabled = true, domains = ${domains} } }`,
    ],
  ];
}

export function codexArgs(options: CodexRunOptions): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config'];
  args.push('-C', options.cwd);
  if (options.model !== undefined) args.push('-m', options.model);
  const set = (key: string, value: string) => args.push('-c', `${key}=${value}`);
  set('approval_policy', toml('never'));
  set('developer_instructions', toml(options.instructions));
  set('web_search', toml('disabled'));
  // Codex's own helpers would act outside the platform's sight: subagents, goals, browsers.
  // And what a ChatGPT sign-in brings with it on a computer, the person's apps and connectors,
  // their plugins and hooks: an agent's tools are the gateway's, under its owner's policies.
  for (const feature of [
    'multi_agent',
    'multi_agent_v2',
    'goals',
    'image_generation',
    'browser_use',
    'browser_use_external',
    'in_app_browser',
    'computer_use',
    'apps',
    'plugins',
    'remote_plugin',
    'plugin_sharing',
    'tool_suggest',
    'skill_mcp_dependency_install',
    'hooks',
  ]) {
    args.push('--disable', feature);
  }
  // The switches above leave the model its instructions for a team of subagents (0.163.0, where
  // they come with the model); this setting takes those away as well.
  set('agents.enabled', 'false');
  if (!options.shell) args.push('--disable', 'shell_tool', '--disable', 'unified_exec');
  if (options.server) {
    // The container is the sandbox: read-only but for the run, its own network (compose.yaml).
    set('sandbox_mode', toml(options.shell ? 'danger-full-access' : 'workspace-write'));
  } else {
    if (options.unsandboxed) set('sandbox_mode', toml('danger-full-access'));
    // Not `sandbox_mode`: Codex takes one or the other, and the older one reads the whole disk.
    else for (const [key, value] of sandboxConfig(options.sandbox ?? NOTHING_OPEN)) set(key, value);
    // The run token is the gateway's, not the commands': with it a command could write the
    // run's own transcript. And git stops at a ~/.gitconfig it may not read, and warns at each
    // command about the ignore file beside it, so it is given neither.
    const git = table([
      ['GIT_CONFIG_GLOBAL', toml('/dev/null')],
      ['GIT_CONFIG_COUNT', toml('1')],
      ['GIT_CONFIG_KEY_0', toml('core.excludesFile')],
      ['GIT_CONFIG_VALUE_0', toml('/dev/null')],
    ]);
    set('shell_environment_policy', `{ inherit = "all", exclude = ["AGENTOME_*"], set = ${git} }`);
  }
  if (options.mcp !== undefined) {
    set('mcp_servers.agentome.url', toml(options.mcp.url));
    set('mcp_servers.agentome.bearer_token_env_var', toml(RUN_TOKEN_VAR));
    // A call that waits for the owner's approval outlasts the run's time limit.
    set('mcp_servers.agentome.tool_timeout_sec', String(OWNER_WAIT_MS / 1000));
  }
  if (options.billing.mode === 'provider') {
    const base = `${options.billing.baseUrl.replace(/\/+$/, '')}/v1`;
    set(
      'model_providers.agentome',
      `{ name = "Agentome", base_url = ${toml(base)}, env_key = "${MODEL_KEY_VAR}", wire_api = "responses" }`,
    );
    set('model_provider', toml('agentome'));
  }
  args.push('-');
  return args;
}

/** What the CLI takes of the worker's environment. */
function inherited(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      (inheritedVar(name, INHERITED_VARS) || name.startsWith(FAKE_PREFIX)) &&
      value !== undefined
    ) {
      result[name] = value;
    }
  }
  return result;
}

function codexEnvironment(options: CodexRunOptions): NodeJS.ProcessEnv {
  const result = inherited(options.env ?? process.env);
  if (options.mcp !== undefined) result[RUN_TOKEN_VAR] = options.mcp.token;
  if (options.billing.mode === 'provider') result[MODEL_KEY_VAR] = options.billing.key;
  return result;
}

const NOTHING_OPEN: CodexSandbox = { readable: [], hosts: [] };

// Run in the sandbox before a computer run: 41 when it can list the person's home, 42 when it
// connects past the proxy to the address given, 0 when both are refused.
const SANDBOX_PROBE = `
const [host, port] = process.argv.slice(1);
try { require('node:fs').readdirSync(require('node:os').homedir()); process.exit(41); } catch {}
if (!host) process.exit(0);
const socket = require('node:net').connect(Number(port), host);
socket.on('connect', () => process.exit(42));
socket.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 3000);
`;

/**
 * Why a computer run may not start, or nothing: Codex is older than the sandbox was checked
 * against, or a command in the sandbox, set up as the run's will be, got into the person's
 * home or past the proxy. It fails closed: a probe that could not run refuses the run too.
 */
export async function sandboxRefusal(
  options: Pick<CodexRunOptions, 'cwd' | 'sandbox' | 'mcp' | 'cliPath' | 'env'>,
): Promise<ClaudeRunError | undefined> {
  const env = options.env ?? process.env;
  const found = await probeCodex({ cliPath: options.cliPath, env });
  // No answer to --version is no check: a missing CLI, and one that only hung, alike.
  if (!found.installed) return notInstalled(options.cliPath ?? 'codex', 'no answer to --version');
  const version = (found.version ?? '0.0.0').split('.').map(Number);
  const behind = LAPTOP_MIN.findIndex((part, i) => (version[i] ?? 0) !== part);
  if (behind !== -1 && (version[behind] ?? 0) < (LAPTOP_MIN[behind] ?? 0)) {
    return {
      code: 'sandbox_unavailable',
      message: `Codex ${found.version ?? 'of an unknown version'} is too old to run an agent on a person's computer: its sandbox cannot keep the agent from your files. Update it (npm install -g @openai/codex) to ${LAPTOP_MIN.join('.')} or later.`,
    };
  }
  // Straight to the gateway, where a connection outside the sandbox would get through.
  const gateway = options.mcp ? new URL(options.mcp.url) : undefined;
  const port = gateway?.port || (gateway?.protocol === 'http:' ? '80' : '443');
  const args = ['sandbox', '-P', PROFILE, '-C', options.cwd];
  for (const [key, value] of sandboxConfig(options.sandbox ?? NOTHING_OPEN)) {
    args.push('-c', `${key}=${value}`);
  }
  // `--` before the host: it is the server's to name, and Node would take one that starts
  // with a dash as an option of its own, `-v` say, and exit well without running the probe.
  args.push('--', process.execPath, '-e', SANDBOX_PROBE, '--');
  if (gateway) args.push(gateway.hostname, port);
  const [file, ...first] = cliCommand(options.cliPath ?? 'codex', env);
  const exit = await new Promise<number | string>((resolve) => {
    // The run's own environment but for its tokens: the probe is no run.
    const child = execFile(
      file,
      [...first, ...args],
      { timeout: PROBE_TIMEOUT_MS, env: inherited(env), windowsHide: true },
      (error) => resolve(error ? (error.code ?? 'failed') : 0),
    );
    child.stdin?.end();
  });
  if (exit === 0) return undefined;
  const what =
    exit === 41
      ? 'a command in it could list your home folder'
      : exit === 42
        ? 'a command in it could connect past the proxy'
        : `the check could not run (${exit})`;
  return {
    code: 'sandbox_unavailable',
    message: `Codex's sandbox does not hold on this computer: ${what}. The run did not start. Update Codex (npm install -g @openai/codex), or set the agent to Claude Code.`,
  };
}

/** Whether Codex is on this computer, and which. */
export async function probeCodex(options: { cliPath?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env;
  const [file, ...first] = cliCommand(options.cliPath ?? 'codex', env);
  const output = await new Promise<string | undefined>((resolve) => {
    execFile(
      file,
      [...first, '--version'],
      { timeout: PROBE_TIMEOUT_MS, env: inherited(env), windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
  return output === undefined
    ? { installed: false as const }
    : { installed: true as const, version: /\b\d+\.\d+\.\d+\b/.exec(output)?.[0] };
}

/** Whether Codex says it is signed out on this computer; only that "no" is believed. */
export async function codexSignedOut(options: { cliPath?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env;
  const settings = {
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL' as const,
    env: inherited(env),
    windowsHide: true,
  };
  const [file, ...first] = cliCommand(options.cliPath ?? 'codex', env);
  const output = await new Promise<string>((resolve) => {
    try {
      // It exits 1 when signed out: what it printed is read whatever its exit code.
      const child = execFile(file, [...first, 'login', 'status'], settings, (_, stdout, stderr) =>
        resolve(`${stdout}\n${stderr}`),
      );
      child.stdin?.end();
    } catch {
      // A path `execFile` refuses outright says nothing either.
      resolve('');
    }
  });
  return /\bnot logged in\b/i.test(output);
}

type Item = { id?: string; type?: string; [field: string]: unknown };

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));
const cut = (value: string) =>
  value.length > OUTPUT_CHARS ? `${value.slice(0, OUTPUT_CHARS)}\n… (cut)` : value;

/** One JSONL line of `codex exec --json` as run events; state keeps what the end needs. */
export function codexEvents(
  line: string,
  state: { model: string; lastMessage?: string; failure?: string; usage?: TokenUsage },
): RunEventDraft[] {
  let event: { type?: string; [field: string]: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return [{ type: 'unknown', rawType: 'invalid_json', raw: line.slice(0, 2000) }];
  }
  const item = (event.item ?? {}) as Item;
  const id = typeof item.id === 'string' && item.id !== '' ? item.id : 'item';
  switch (event.type) {
    case 'thread.started':
      return [
        {
          type: 'started',
          sessionId: String(event.thread_id ?? '') || undefined,
          model: state.model,
        },
      ];
    case 'turn.started':
      return [];
    case 'item.started':
      if (item.type === 'command_execution') {
        return [{ type: 'tool_use', id, name: 'Bash', input: { command: item.command } }];
      }
      if (item.type === 'mcp_tool_call') {
        const name = `mcp__${text(item.server)}__${text(item.tool)}`;
        return [{ type: 'tool_use', id, name, input: item.arguments ?? {} }];
      }
      return [];
    case 'item.completed':
      return completed(item, id, state);
    case 'turn.completed': {
      const usage = (event.usage ?? {}) as TokenUsage;
      state.usage = usage;
      const cached = usage.cached_input_tokens ?? 0;
      return [
        {
          type: 'usage',
          model: state.model,
          // OpenAI counts the cached part inside the input; the ledger keeps them apart.
          tokensIn: Math.max(0, (usage.input_tokens ?? 0) - cached),
          tokensOut: usage.output_tokens ?? 0,
          tokensCacheRead: cached,
          tokensCacheWrite: usage.cache_write_input_tokens ?? 0,
          tokensCacheWrite1h: 0,
          total: true,
        },
        { type: 'result', text: state.lastMessage ?? '', isError: false },
      ];
    }
    case 'turn.failed': {
      const message = text(
        (event.error as { message?: unknown } | undefined)?.message ?? event.error,
      );
      state.failure = message;
      return [{ type: 'result', text: message, isError: true }];
    }
    case 'error':
      // Codex says it is reconnecting here; the turn's own failure ends the run, not this.
      return [{ type: 'error', code: 'codex_error', message: text(event.message), fatal: false }];
    default:
      return [{ type: 'unknown', rawType: String(event.type ?? 'untyped'), raw: event }];
  }
}

type TokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
};

function completed(item: Item, id: string, state: { lastMessage?: string }): RunEventDraft[] {
  switch (item.type) {
    case 'agent_message': {
      const said = text(item.text);
      state.lastMessage = said;
      return [{ type: 'assistant_message', text: said }];
    }
    case 'command_execution':
      return [
        {
          type: 'tool_result',
          toolUseId: id,
          output: cut(text(item.aggregated_output)),
          isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
        },
      ];
    case 'mcp_tool_call': {
      const failed = item.error !== undefined && item.error !== null;
      const output = failed
        ? text((item.error as { message?: unknown }).message ?? item.error)
        : text(item.result);
      return [{ type: 'tool_result', toolUseId: id, output: cut(output), isError: failed }];
    }
    case 'file_change':
      return [
        { type: 'tool_use', id, name: 'Edit', input: { changes: item.changes } },
        {
          type: 'tool_result',
          toolUseId: id,
          output: text(item.status),
          isError: item.status === 'failed',
        },
      ];
    case 'todo_list': {
      // The run page reads a plan from TodoWrite's list.
      const items = Array.isArray(item.items)
        ? (item.items as { text?: unknown; completed?: unknown }[])
        : [];
      const todos = items.map((todo) => ({
        content: text(todo.text),
        status: todo.completed === true ? 'completed' : 'pending',
      }));
      return [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }];
    }
    case 'error':
      return [{ type: 'error', code: 'codex_warning', message: text(item.message), fatal: false }];
    case 'reasoning':
      return [];
    default:
      return [{ type: 'unknown', rawType: `item.${String(item.type)}`, raw: item }];
  }
}

/**
 * Every process under `pid`. Codex starts each command in a process group of its own, which a
 * signal to Codex's group does not reach: without these a cancelled run's command would go on
 * on the person's computer, in its sandbox still, for as long as it liked.
 */
function descendants(pid: number): number[] {
  let listed: string;
  try {
    listed = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of listed.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const queue = [pid];
  for (let i = 0; i < queue.length; i++) {
    const under = children.get(queue[i] ?? 0) ?? [];
    found.push(...under);
    queue.push(...under);
  }
  return found;
}

/** The signal to a process and to the group it leads; gone already is fine. */
function signalTree(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, signal);
      } catch (error) {
        // Gone already, not the leader of a group, or no longer ours: nothing to stop there.
        const { code } = error as NodeJS.ErrnoException;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
    }
  }
}

/**
 * Runs Codex for one run and reports its transcript to `sink`, numbered from 0, then — unless
 * the turn completed — one fatal `error` with how the run ended. Resolves once the process group
 * is gone; rejects only when `sink` throws, after stopping the CLI.
 */
export async function runCodex(
  options: CodexRunOptions,
  sink: RunEventSink,
  signal: AbortSignal,
): Promise<ClaudeRunOutcome> {
  let seq = 0;
  let sinkError: { readonly cause: unknown } | undefined;
  const emit = (draft: RunEventDraft): RunEvent | undefined => {
    if (sinkError) return undefined;
    try {
      const event: RunEvent = { ...draft, seq: seq++, at: new Date().toISOString() };
      sink(event);
      return event;
    } catch (cause) {
      sinkError = { cause };
      return undefined;
    }
  };
  const state: { model: string; lastMessage?: string; failure?: string; usage?: TokenUsage } = {
    model: options.model ?? 'codex-default',
  };
  let sessionId: string | undefined;
  let completedTurn = false;
  let ended: ClaudeRunError | undefined;
  let stderr = '';
  const totals = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
  const outcome = (error?: ClaudeRunError): ClaudeRunOutcome => {
    if (sinkError) throw sinkError.cause;
    return {
      status: !error ? 'done' : error.code === RUN_CANCELLED_CODE ? 'cancelled' : 'failed',
      sessionId,
      resultText: state.lastMessage ?? state.failure,
      error,
      usage: totals,
    };
  };
  const fail = (error: ClaudeRunError): ClaudeRunOutcome => {
    emit({ type: 'error', ...error, fatal: true });
    return outcome(error);
  };
  if (options.billing.mode === 'provider' && options.billing.key.trim() === '') {
    return fail({
      code: 'invalid_options',
      message: 'A run through a model connection needs its key.',
    });
  }
  if (signal.aborted) return fail({ code: RUN_CANCELLED_CODE, message: 'The run was cancelled.' });
  if (!options.server && !options.unsandboxed) {
    const refusal = await sandboxRefusal(options);
    if (refusal) return fail(refusal);
  }

  const cliPath = options.cliPath ?? 'codex';
  let child: ChildProcess;
  try {
    const [file, ...first] = cliCommand(cliPath, options.env ?? process.env);
    child = spawn(file, [...first, ...codexArgs(options)], {
      cwd: options.cwd,
      env: codexEnvironment(options),
      stdio: 'pipe',
      ...childOptions(),
    });
  } catch (cause) {
    return fail(notInstalled(cliPath, cause));
  }

  let stopping = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Listed while Codex is still their parent: once it is gone they are nobody's. Windows
    // has no groups to miss: taskkill ends the whole tree under Codex at once.
    const windows = process.platform === 'win32';
    const commands = child.pid === undefined || windows ? [] : descendants(child.pid);
    const all = (with_: NodeJS.Signals) => {
      stopTree(child, with_);
      signalTree(commands, with_);
    };
    all('SIGTERM');
    killTimer = setTimeout(() => all('SIGKILL'), KILL_GRACE_MS);
  };
  const end = (error: ClaudeRunError) => {
    if (!ended && !completedTurn) {
      ended = error;
      emit({ type: 'error', ...error, fatal: true });
    }
    stop();
  };

  let buffered = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      for (const draft of codexEvents(line, state)) {
        if (draft.type === 'started') sessionId = draft.sessionId;
        if (draft.type === 'result' && !draft.isError) completedTurn = true;
        const event = emit(draft);
        if (!event) return stop();
        if (event.type !== 'usage') continue;
        totals.tokensIn += event.tokensIn;
        totals.tokensOut += event.tokensOut;
        totals.tokensCacheRead += event.tokensCacheRead;
        totals.tokensCacheWrite += event.tokensCacheWrite;
      }
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(options.prompt);

  const ms = options.limits.timeoutMs;
  const allowed = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`;
  // As Claude Code's launcher: the time the run waited for its owner is not its own, so
  // the timer looks again when it fires.
  const deadline = Date.now() + ms;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    const left = deadline + (options.limits.waitedMs?.() ?? 0) - Date.now();
    const timeout = () =>
      end({
        code: 'timeout',
        message: `The run exceeded its time limit of ${allowed} and was stopped.`,
      });
    timer = setTimeout(left > 0 ? arm : timeout, Math.max(0, left));
  };
  arm();
  const onAbort = () => end({ code: RUN_CANCELLED_CODE, message: 'The run was cancelled.' });
  signal.addEventListener('abort', onAbort, { once: true });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    child.on('error', (error) => {
      if (child.pid === undefined) resolve({ code: null, signal: null, error });
    });
    child.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }));
  });
  clearTimeout(timer);
  clearTimeout(killTimer);
  signal.removeEventListener('abort', onAbort);

  if (exit.error) return fail(notInstalled(cliPath, exit.error));
  if (ended) return outcome(ended);
  const used =
    totals.tokensIn + totals.tokensOut + totals.tokensCacheRead + totals.tokensCacheWrite;
  if (completedTurn && used > options.limits.maxTokens) {
    // Codex reports usage once, at the end of the turn: the limit is told, not enforced, here.
    emit({
      type: 'error',
      code: 'token_limit',
      message: `The run used ${used} tokens, more than its limit of ${options.limits.maxTokens}.`,
      fatal: false,
    });
  }
  if (completedTurn && exit.code === 0) return outcome();
  return fail(failure(exit, state.failure, stderr));
}

function notInstalled(cliPath: string, cause: unknown): ClaudeRunError {
  const reason = (cause as NodeJS.ErrnoException | undefined)?.code ?? String(cause);
  const message = `Codex could not be started (${cliPath}: ${reason}). Install it (npm install -g @openai/codex), and make sure \`codex\` is on the PATH of the agent service.`;
  return { code: 'not_installed', message };
}

function failure(
  exit: { code: number | null; signal: NodeJS.Signals | null },
  said: string | undefined,
  stderr: string,
): ClaudeRunError {
  const all = `${said ?? ''}\n${stderr}`;
  const tail = (said?.trim() || stderr.trim()).slice(-500);
  const detail = tail === '' ? '' : ` Codex said: ${tail}`;
  if (NOT_AUTHENTICATED.test(all)) {
    const message = `Codex is not signed in, or its key was refused. On a person's computer run \`codex login\`; on the server check the model connection.${detail}`;
    return { code: 'not_authenticated', message };
  }
  if (RATE_LIMITED.test(all)) {
    return { code: 'rate_limited', message: `The model's usage limit was reached.${detail}` };
  }
  const n = exit.code ?? 128 + (exit.signal === null ? 0 : constants.signals[exit.signal]);
  return {
    code: `exit_${n}`,
    message: `Codex ended without finishing its turn (exit code ${n}).${detail}`,
  };
}
