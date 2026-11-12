import { StringDecoder } from 'node:string_decoder';

import type { RunEventDraft } from '@agentome/shared';

// `claude -p --output-format stream-json --verbose` → run events. The format is neither fully
// documented nor versioned, so one rule: every line yields an event (bar the CLI's housekeeping,
// below), and what cannot be read becomes `unknown` under the producer's own name — a run
// survives a CLI upgrade and the drift stays visible. It never throws.

/** Text kept of an unreadable line, a tool output or an oversized value; the rest is cut. */
export const MAX_TEXT_CHARS = 4000;
/** A line longer than this is not a transcript line any more and is dropped. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** Model of a message the CLI wrote itself (a failed login, a limit notice). */
const SYNTHETIC_MODEL = '<synthetic>';

/** What the parser has learned; the launcher reads it once the process has exited. */
export interface ParserState {
  sessionId?: string;
  model?: string;
  /** How the CLI said the run ended; absent until its `result` line. */
  result?: { readonly isError: boolean; readonly subtype?: string; readonly text: string };
  /**
   * The CLI's own words about failures, which the launcher decides from. Never the result
   * text: on `error_max_turns` it is the model's last answer, which a repository can steer.
   */
  readonly diagnostics: string[];
  /** How many usage events of turns there were: none means the run burned no tokens yet. */
  turnUsage: number;
  /**
   * Hour-long cache writes per API message, the latest report of each, with its model: the
   * totals of a run with several models do not split their cache writes, the turns do.
   */
  readonly cacheWrites1h: Map<string | symbol, { readonly model: string; readonly tokens: number }>;
  /** A team member's tool calls and the lead's assignment each is under. */
  readonly memberCalls: Map<string, string>;
}

type Json = Record<string, unknown>;

/** An object, not an array, not null. */
function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clip(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}… (${String(text.length - MAX_TEXT_CHARS)} more characters)`;
}

/** A value as it came, or its JSON cut short: one line must not become a megabyte event. */
function bounded(value: unknown): unknown {
  if (typeof value === 'string') return clip(value);
  const text = JSON.stringify(value);
  return text === undefined || text.length <= MAX_TEXT_CHARS ? value : clip(text);
}

function unknown(rawType: string, raw: unknown): RunEventDraft {
  return { type: 'unknown', rawType, raw: bounded(raw) };
}

/** Tokens of a usage block in our names, or nothing for a block that burned none. */
function readTokens(usage: unknown) {
  const block = asRecord(usage);
  const tokensCacheWrite = count(block?.cache_creation_input_tokens);
  const split = asRecord(block?.cache_creation);
  const tokens = {
    tokensIn: count(block?.input_tokens),
    tokensOut: count(block?.output_tokens),
    tokensCacheRead: count(block?.cache_read_input_tokens),
    tokensCacheWrite,
    tokensCacheWrite1h: Math.min(count(split?.ephemeral_1h_input_tokens), tokensCacheWrite),
  };
  // The synthetic message of a failed run reports zeros; a zero for a model that never
  // answered is not usage but a ledger row nobody can explain.
  return Object.values(tokens).some((value) => value > 0) ? tokens : undefined;
}

/** A tool's output as text: a string, or the text blocks of a content array. */
function toolOutput(content: unknown): string {
  if (typeof content === 'string') return clip(content);
  if (content === undefined || content === null) return '';
  if (!Array.isArray(content)) return clip(JSON.stringify(content));
  const parts = content.map((raw) => {
    const block = asRecord(raw);
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    return `[${asString(block?.type) ?? 'block'}]`;
  });
  return clip(parts.join('\n'));
}

/** Unix seconds (or milliseconds) as ISO 8601; nothing for a value that is not a time. */
function isoTime(value: unknown): string | undefined {
  const date = new Date(count(value) >= 1e12 ? count(value) : count(value) * 1000);
  return count(value) > 0 && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * System lines the CLI writes about the computer it runs on, not about the conversation: the
 * person's installed commands and plugins (`commands_changed`, which must never be stored), the
 * state of their checkout, a running estimate of thinking tokens. They yield no event, so no
 * row on the server and no screen holds them.
 */
const HOUSEKEEPING_SUBTYPES: ReadonlySet<string> = new Set([
  'commands_changed',
  'vcs_state_changed',
  'thinking_tokens',
  // A team member's progress, which its Agent call and the events under it already tell.
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
]);

function system(line: Json, state: ParserState): RunEventDraft[] {
  const subtype = asString(line.subtype) ?? 'unknown';
  if (HOUSEKEEPING_SUBTYPES.has(subtype)) return [];
  if (subtype !== 'init') return [unknown(`system/${subtype}`, line)];
  const model = asString(line.model);
  if (model !== undefined && model !== SYNTHETIC_MODEL) state.model = model;
  const cliVersion = asString(line.claude_code_version);
  return [{ type: 'started', sessionId: state.sessionId, model, cliVersion }];
}

/** `member`: a team member's line, whose model is not the run's. */
function assistant(line: Json, state: ParserState, member: boolean): RunEventDraft[] {
  const message = asRecord(line.message);
  if (message === undefined) return [unknown('assistant', line)];

  const events: RunEventDraft[] = [];
  for (const block of asArray(message.content).map(asRecord)) {
    const kind = asString(block?.type) ?? 'block';
    // Thinking is the model's scratch pad: long, and not part of the transcript.
    if (block === undefined || kind === 'thinking' || kind === 'redacted_thinking') continue;
    if (kind === 'text') {
      const text = asString(block.text);
      if (text !== undefined) events.push({ type: 'assistant_message', text });
      continue;
    }
    const id = asString(block.id);
    const name = asString(block.name);
    // A call without an id or a name cannot be paired or shown: kept as is, never guessed.
    events.push(
      kind === 'tool_use' && id !== undefined && name !== undefined
        ? { type: 'tool_use', id, name, input: bounded(block.input ?? {}) }
        : unknown(`assistant/${kind}`, block),
    );
  }

  // A failure the CLI pins on a message (a failed login) is a note; the result ends the run.
  const error = asString(line.error);
  if (error !== undefined) {
    state.diagnostics.push(error);
    const note = `Claude Code flagged a message: ${error}`;
    events.push({ type: 'error', code: error, message: note, fatal: false });
  }

  const model = asString(message.model);
  if (model !== undefined && model !== SYNTHETIC_MODEL && !member) state.model = model;
  const tokens = readTokens(message.usage);
  if (tokens !== undefined) {
    state.turnUsage += 1;
    const messageId = asString(message.id);
    const usedBy = model ?? state.model ?? 'unknown';
    const key = messageId ?? Symbol('turn without an id');
    state.cacheWrites1h.set(key, { model: usedBy, tokens: tokens.tokensCacheWrite1h });
    events.push({ type: 'usage', model: usedBy, ...tokens, messageId });
  }
  return events.length > 0 ? events : [unknown('assistant', line)];
}

/** `member`: a team member's line, whose text is its assignment, the lead's call's input. */
function user(line: Json, member: boolean): RunEventDraft[] {
  const events = asArray(asRecord(line.message)?.content).flatMap((raw): RunEventDraft[] => {
    const block = asRecord(raw);
    if (block === undefined || (member && block.type === 'text')) return [];
    const toolUseId = asString(block.tool_use_id);
    if (block.type !== 'tool_result' || toolUseId === undefined) {
      return [unknown(`user/${asString(block.type) ?? 'block'}`, block)];
    }
    const output = toolOutput(block.content);
    return [{ type: 'tool_result', toolUseId, output, isError: block.is_error === true }];
  });
  return events.length > 0 || member ? events : [unknown('user', line)];
}

function result(line: Json, state: ParserState): RunEventDraft[] {
  // Success is `is_error`, not `subtype`: a CLI that failed to log in prints
  // `{"subtype":"success","is_error":true}` (fixtures/auth-401.jsonl).
  const isError = line.is_error === true;
  const text = typeof line.result === 'string' ? line.result : '';
  state.result = { isError, subtype: asString(line.subtype), text };
  for (const entry of [...asArray(line.errors), line.error]) {
    const said = typeof entry === 'string' ? entry : asString(asRecord(entry)?.message);
    if (said !== undefined && said !== '') state.diagnostics.push(said);
  }

  const events: RunEventDraft[] = resultTotals(line, state);
  events.push({ type: 'result', text, isError, sessionId: state.sessionId });
  state.cacheWrites1h.clear();
  return events;
}

/**
 * The run's totals per model, which replace its turns (`countedUsage`): every line of an answer
 * repeats the usage the CLI had when the answer started, so the turns report a few output tokens
 * for an answer that wrote a file. Per model from `modelUsage`; from `usage` when a CLI
 * gives no `modelUsage`. Per-turn usage still arrives as it comes, for the token limit of a live
 * run and for a run that is killed before its result.
 */
function resultTotals(line: Json, state: ParserState): RunEventDraft[] {
  const run = readTokens(line.usage);
  const models = Object.entries(asRecord(line.modelUsage) ?? {}).flatMap(([model, raw]) => {
    const entry = asRecord(raw);
    const tokens = {
      tokensIn: count(entry?.inputTokens),
      tokensOut: count(entry?.outputTokens),
      tokensCacheRead: count(entry?.cacheReadInputTokens),
      tokensCacheWrite: count(entry?.cacheCreationInputTokens),
    };
    const burned = Object.values(tokens).some((value) => value > 0);
    return burned && model !== SYNTHETIC_MODEL ? [{ model, ...tokens }] : [];
  });
  if (models.length === 0) {
    return run === undefined
      ? []
      : [{ type: 'usage', model: state.model ?? 'unknown', ...run, total: true }];
  }
  return models.map((tokens) => {
    // `usage` splits the run's cache writes by how long they live, `modelUsage` does not. With
    // one model the split is that model's; with several, each takes what its turns wrote.
    let hour = run?.tokensCacheWrite1h ?? 0;
    if (models.length > 1) {
      hour = 0;
      for (const turn of state.cacheWrites1h.values()) {
        if (turn.model === tokens.model) hour += turn.tokens;
      }
    }
    const tokensCacheWrite1h = Math.min(hour, tokens.tokensCacheWrite);
    return { type: 'usage', ...tokens, tokensCacheWrite1h, total: true };
  });
}

// `rate_limit_event` comes on every 2.1.x run. `allowed` is housekeeping like the system lines
// above and says nothing; `rejected` means the account has nothing left, so the transcript
// gets a note (the result ends the run). Any other status stays `unknown`, so that one nobody
// has seen yet shows.
function rateLimit(line: Json, state: ParserState): RunEventDraft[] {
  const info = asRecord(line.rate_limit_info);
  if (info?.status === 'allowed') return [];
  if (info?.status !== 'rejected') return [unknown('rate_limit_event', line)];
  state.diagnostics.push('rate_limited');
  const window = asString(info.rateLimitType) ?? 'usage';
  const resetsAt = isoTime(info.resetsAt);
  const when = resetsAt === undefined ? '' : `, which resets at ${resetsAt}`;
  const message = `The Claude account has reached its ${window} limit${when}.`;
  return [
    unknown('rate_limit_event', line),
    { type: 'error', code: 'rate_limited', message, fatal: false },
  ];
}

function parseLine(line: string, state: ParserState): RunEventDraft[] {
  const text = line.trim();
  if (text === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [unknown('invalid_json', text)];
  }

  const parsed = asRecord(value);
  if (parsed === undefined) return [unknown('non_object', value)];
  const sessionId = asString(parsed.session_id);
  if (sessionId !== undefined) state.sessionId = sessionId;

  // A team member's line names the lead's Agent call it works under. A denial of one
  // of its calls names only that call, which came before it under the assignment.
  const toolUseId = asString(parsed.tool_use_id);
  const parent =
    asString(parsed.parent_tool_use_id) ??
    (toolUseId === undefined ? undefined : state.memberCalls.get(toolUseId));
  const events = dispatch(parsed, state, parent !== undefined);
  if (parent === undefined) return events;
  return events.map((event) => {
    if (event.type === 'tool_use') state.memberCalls.set(event.id, parent);
    return event.type === 'usage' ||
      event.type === 'error' ||
      event.type === 'started' ||
      event.type === 'result'
      ? event
      : { ...event, parentToolUseId: parent };
  });
}

function dispatch(parsed: Json, state: ParserState, member: boolean): RunEventDraft[] {
  const type = asString(parsed.type);
  switch (type) {
    case undefined:
      return [unknown('untyped', parsed)];
    case 'system':
      return system(parsed, state);
    case 'assistant':
      return assistant(parsed, state, member);
    case 'user':
      return user(parsed, member);
    case 'result':
      return result(parsed, state);
    case 'rate_limit_event':
      return rateLimit(parsed, state);
    case 'tool_progress':
      // A heartbeat of a long call (a team member's Agent call) says only that it still runs.
      return parsed.heartbeat === true ? [] : [unknown(type, parsed)];
    default:
      // `stream_event`, `tool_progress` and whatever comes next carry nothing the
      // transcript does not get from `assistant`/`user`: kept whole under their own name.
      return [unknown(type, parsed)];
  }
}

/**
 * The line splitter over stdout; not `readline`, because events must leave synchronously, in
 * the order the launcher numbers them. A line that never ends is dropped with a marker.
 */
export function createStreamJsonParser() {
  const state: ParserState = {
    diagnostics: [],
    turnUsage: 0,
    cacheWrites1h: new Map(),
    memberCalls: new Map(),
  };
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let skipping = false;

  return {
    state,
    /** Feeds a chunk of stdout; returns the events of the lines it completed. */
    push(chunk: Buffer | string): RunEventDraft[] {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const events: RunEventDraft[] = [];
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (skipping) skipping = false;
        else events.push(...parseLine(line, state));
      }
      // Characters first: at four bytes a character at most, a shorter buffer cannot be over.
      if (buffer.length * 4 > MAX_LINE_BYTES && Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        if (!skipping) {
          const note = `a line exceeded ${String(MAX_LINE_BYTES)} bytes and was dropped`;
          events.push(unknown('line_overflow', note));
        }
        buffer = '';
        skipping = true;
      }
      return events;
    },
    /** Flushes a last line that had no newline after it. */
    end(): RunEventDraft[] {
      const rest = buffer + decoder.end();
      buffer = '';
      if (skipping) return [];
      return parseLine(rest, state);
    },
  };
}
