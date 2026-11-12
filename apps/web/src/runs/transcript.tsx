import { ChevronRight } from 'lucide-react';
import {
  createContext,
  memo,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../ui/cn';
import { jumpTo, Markdown } from '../ui/markdown';
import { StatusMarker } from '../ui/status';
import { AgentTile } from '../ui/tint';
import {
  formatDuration,
  type RunEvent,
  type TeamMember,
  type ToolCallDecision,
  turnTokens,
} from './run-data';

type Of<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

export type Block =
  | { kind: 'event'; event: Of<'started' | 'assistant_message' | 'error' | 'unknown'> }
  | {
      kind: 'tool';
      seq: number;
      use?: Of<'tool_use'>;
      result?: Of<'tool_result'>;
      /** A team member's events, under the lead's call that gave it the work. */
      children?: RunEvent[];
    }
  | { kind: 'usage'; seq: number; event: Of<'usage'> }
  | { kind: 'system'; seq: number; events: Of<'unknown'>[] }
  | { kind: 'result'; event: Of<'result'>; repeats: boolean };

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;

/**
 * What Claude Code says about itself rather than about the work: its system lines, and a rate
 * limit that let the run go on. Runs stored before the worker dropped the commonest of them
 * are full of these. A system line that carries an error (an API retry after a 401 or a
 * 529), a limit that warned or stopped the run, and every other event nobody knows stay rows.
 */
function isHousekeeping({ rawType, raw }: Of<'unknown'>): boolean {
  if (rawType === 'rate_limit_event') {
    return field(field(raw, 'rate_limit_info'), 'status') === 'allowed';
  }
  const failed =
    field(raw, 'error') !== undefined ||
    field(raw, 'error_status') !== undefined ||
    field(raw, 'is_error') === true;
  return rawType.startsWith('system/') && !failed;
}

/**
 * The transcript as blocks to show, in seq order, each event once. A tool call and its result
 * are one block. Usage closes its turn: the CLI repeats an API message's usage on every line it
 * splits the message into, so the turn's line stands at the last of them, after the turn's last
 * call, with the latest numbers. The totals of the result are the run's cost, not a turn, and
 * are not shown here. Housekeeping folds into one block where the first of it came, and a
 * message, a call or its result ends the fold: a `compact_boundary` mid-run stays between the
 * turns it came between, where it says what the agent forgot. A result whose text is the last
 * message again is not shown twice.
 */
export function foldTranscript(events: readonly RunEvent[]): Block[] {
  const bySeq = new Map<number, RunEvent>();
  for (const event of events) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  const blocks: Block[] = [];
  const calls = new Map<string, Extract<Block, { kind: 'tool' }>>();
  const turns = new Map<string, Block>();
  const moved = new Set<Block>();
  let system: Extract<Block, { kind: 'system' }> | undefined;
  let lastText = '';
  for (const event of [...bySeq.values()].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'usage' && event.total) continue;
    const parent = 'parentToolUseId' in event ? calls.get(event.parentToolUseId ?? '') : undefined;
    if (parent) {
      (parent.children ??= []).push(event);
      continue;
    }
    const housekeeping = event.type === 'unknown' && isHousekeeping(event);
    if (!housekeeping && event.type !== 'usage') system = undefined;
    if (event.type === 'tool_use') {
      const block: Extract<Block, { kind: 'tool' }> = { kind: 'tool', seq: event.seq, use: event };
      calls.set(event.id, block);
      blocks.push(block);
    } else if (event.type === 'tool_result') {
      const call = calls.get(event.toolUseId);
      if (call && !call.result) call.result = event;
      else blocks.push({ kind: 'tool', seq: event.seq, result: event });
    } else if (event.type === 'usage') {
      const block: Block = { kind: 'usage', seq: event.seq, event };
      const earlier = event.messageId ? turns.get(event.messageId) : undefined;
      if (earlier) moved.add(earlier);
      if (event.messageId) turns.set(event.messageId, block);
      blocks.push(block);
    } else if (housekeeping) {
      if (system) system.events.push(event);
      else blocks.push((system = { kind: 'system', seq: event.seq, events: [event] }));
    } else if (event.type === 'result') {
      const text = event.text.trim();
      blocks.push({ kind: 'result', event, repeats: text !== '' && text === lastText });
    } else {
      if (event.type === 'assistant_message') lastText = event.text.trim();
      blocks.push({ kind: 'event', event });
    }
  }
  return blocks.filter((block) => !moved.has(block));
}

export type FinalAnswer = { seq: number; text: string };

/**
 * What the transcript ends with, as the fold shows it: the text of the first result, or the
 * last message before it when the result repeats it or says nothing. A run's report is this
 * text again, so its card can point here instead of repeating it.
 */
export function finalAnswer(events: readonly RunEvent[]): FinalAnswer | undefined {
  let message: Of<'assistant_message'> | undefined;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'assistant_message') message = event;
    if (event.type !== 'result') continue;
    const text = event.text.trim();
    if (text && text !== message?.text.trim()) return { seq: event.seq, text };
    break;
  }
  const text = message?.text.trim();
  return message && text ? { seq: message.seq, text } : undefined;
}

const key = (block: Block) =>
  block.kind === 'event' || block.kind === 'result' ? block.event.seq : block.seq;

const isRow = (block?: Block) =>
  block?.kind === 'tool' || (block?.kind === 'event' && block.event.type === 'unknown');

/**
 * How Claude Code names a tool of the gateway: `agentome` for the lead's, `agentome-<key>` for a
 * team member's.
 */
const GATEWAY = /^mcp__agentome(?:-([a-z0-9-]+))?__(.+)$/;
const gatewayTool = (name: string) => {
  const match = GATEWAY.exec(name);
  return match ? { member: match[1], tool: match[2] ?? '' } : undefined;
};

/**
 * The gateway's row for each of its calls in the transcript, by the call's seq. The n-th call of
 * a tool in the transcript is the n-th row of that tool: both are in the order they were made.
 */
function decisionsOf(
  events: readonly RunEvent[],
  calls: readonly ToolCallDecision[],
  team: readonly TeamMember[],
) {
  const seen = new Map<string, number>();
  const found = new Map<number, ToolCallDecision>();
  const members = new Set(team.map((member) => member.agentId));
  const counted = new Set<number>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const gateway = event.type === 'tool_use' ? gatewayTool(event.name) : undefined;
    if (!gateway || counted.has(event.seq)) continue;
    counted.add(event.seq);
    // A member's calls are its own rows, the lead's the rest, each in the order they were made.
    const agentId = team.find((member) => member.key === gateway.member)?.agentId;
    const whose = `${agentId ?? ''}/${gateway.tool}`;
    const n = seen.get(whose) ?? 0;
    seen.set(whose, n + 1);
    const call = calls.filter(
      (item) =>
        item.tool === gateway.tool &&
        (agentId ? item.agentId === agentId : !members.has(item.agentId ?? '')),
    )[n];
    if (call) found.set(event.seq, call);
  }
  return found;
}

/**
 * The run ended done: a step that failed along the way is part of finished work, a test
 * run to see it fail, and says so in the quiet ink. Colour is for what waits and what is broken.
 * A context, since a team member's transcript sits inside its lead's.
 */
const Settled = createContext(false);

export function Transcript(props: {
  events: readonly RunEvent[];
  live: boolean;
  /** The final answer's seq: shown at the top of the page, here a line that points to it. */
  answerAbove?: number;
  toolCalls?: readonly ToolCallDecision[];
  team?: readonly TeamMember[];
  /** A member's transcript inside the lead's: the decisions of the whole run. */
  decisions?: ReadonlyMap<number, ToolCallDecision>;
  /** The run ended done: its failed steps are not an alarm. Inside another transcript, as there. */
  settled?: boolean;
}) {
  // The fold of a run's events; `live` while the run may still add to it.
  const blocks = useMemo(() => foldTranscript(props.events), [props.events]);
  // What was there when the page opened stays still; what streams in after rises into place.
  const atLoad = useRef<number | null>(null);
  if (atLoad.current === null && blocks.length > 0) atLoad.current = blocks.length;
  const found = useMemo(
    () => props.decisions ?? decisionsOf(props.events, props.toolCalls ?? [], props.team ?? []),
    [props.decisions, props.events, props.toolCalls, props.team],
  );
  const team = props.team ?? [];
  // The members whose step waits for the owner: their assignments have not started yet.
  const waiting = useMemo(
    () =>
      new Set(
        (props.toolCalls ?? [])
          .filter((call) => call.tool === 'team_step' && call.decision === 'pending')
          .flatMap((call) => call.members ?? []),
      ),
    [props.toolCalls],
  );
  const isAssignment = (block: Block) =>
    block.kind === 'tool' && Boolean(block.children || assigns(block.use, team));
  const items = groupSteps(
    blocks,
    (block) => !isAssignment(block) && !pending(found.get(key(block))),
  );

  /** One block as the transcript shows it; `previous` is the block before it in its list. */
  const render = (block: Block, previous: Block | undefined, next: Block | undefined) => {
    // A turn's tokens are machinery: they go inside the call that ended the turn, and a turn
    // that ended with prose keeps them to itself; the run's cost is in the aside.
    if (block.kind === 'usage') return null;
    const usage =
      block.kind === 'tool' && next?.kind === 'usage' ? turnTokens(next.event) : undefined;
    // A burst of calls reads as one list. Housekeeping is a footnote of what came before,
    // as close to a row as to a paragraph and set where its text starts; the next turn
    // keeps its distance.
    const footnote = block.kind === 'system';
    const underRow = isRow(previous) || previous?.kind === 'system';
    const index = blocks.indexOf(block);
    return (
      <div
        key={key(block)}
        className={cn(
          props.live && atLoad.current !== null && index >= atLoad.current && 'animate-rise',
          previous && (footnote || (isRow(block) && isRow(previous))) && '-mt-2',
          footnote && underRow && '-mt-3 pl-5.5',
        )}
      >
        {key(block) === props.answerAbove ? (
          <AnswerAbove />
        ) : isAssignment(block) && block.kind === 'tool' ? (
          <Assignment
            block={block}
            live={props.live}
            team={team}
            decisions={found}
            waiting={waiting}
          />
        ) : (
          <Entry block={block} live={props.live} usage={usage} />
        )}
        {block.kind === 'tool' && <Decision call={found.get(block.seq)} />}
      </div>
    );
  };

  // Not given: as the transcript this one is inside of, a member's in its lead's.
  const inherited = useContext(Settled);
  return (
    <Settled.Provider value={props.settled ?? inherited}>
      <div className="grid max-w-205 grid-cols-[minmax(0,1fr)] gap-3">
        {items.map((item, i) => {
          const before = items[i - 1];
          const previous = Array.isArray(before) ? undefined : before;
          if (!Array.isArray(item)) {
            const after = items[i + 1];
            return render(item, previous, Array.isArray(after) ? after[0] : after);
          }
          const steps = item.filter((block) => block.kind !== 'usage' && block.kind !== 'system');
          // One call is its own row: a group of one would only wrap it.
          if (steps.length <= 1) {
            return (
              <div
                key={`group-${key(item[0] as Block)}`}
                className="grid grid-cols-[minmax(0,1fr)] gap-3"
              >
                {item.map((block, j) => render(block, item[j - 1], item[j + 1]))}
              </div>
            );
          }
          return (
            <Steps
              key={`group-${key(item[0] as Block)}`}
              blocks={item}
              // A live run keeps what it is doing now in view.
              auto={props.live && i === items.length - 1}
              live={props.live}
            >
              {item.map((block, j) => render(block, item[j - 1], item[j + 1]))}
            </Steps>
          );
        })}
      </div>
    </Settled.Provider>
  );
}

const pending = (call?: ToolCallDecision) => call?.decision === 'pending';

/**
 * The transcript as the agent's words with the calls between them folded: a run of calls,
 * their usage and the CLI's housekeeping becomes one list, and everything else (a message, an
 * assignment, a call that waits for the owner) stands on its own.
 */
export function groupSteps(
  blocks: readonly Block[],
  groupable: (block: Block) => boolean,
): (Block | Block[])[] {
  const items: (Block | Block[])[] = [];
  let group: Block[] | undefined;
  for (const block of blocks) {
    const step =
      block.kind === 'usage' ||
      block.kind === 'system' ||
      (block.kind === 'tool' && groupable(block)) ||
      (block.kind === 'event' && block.event.type === 'unknown');
    if (!step) {
      group = undefined;
      items.push(block);
    } else if (group) {
      group.push(block);
    } else {
      items.push((group = [block]));
    }
  }
  return items;
}

// What a run of calls did, in the words of its row: the kinds a person tells apart, most first.
const kinds: [RegExp, string, string][] = [
  [/^Bash$/, 'command', 'commands'],
  [/^Read$/, 'file read', 'files read'],
  [/^(Edit|MultiEdit|Write|NotebookEdit)$/, 'file changed', 'files changed'],
  [/^(Grep|Glob|LS)$/, 'search', 'searches'],
  [/^Web(Fetch|Search)$/, 'web lookup', 'web lookups'],
  [/^ask_owner$/, 'question to you', 'questions to you'],
  [/jira/i, 'Jira', 'Jira'],
  [/^code_host_/, 'code host', 'code host'],
  [/^memory_/, 'memory', 'memory'],
  [/^knowledge_/, 'knowledge', 'knowledge'],
  [/^(Agent|Task)$/, 'helper', 'helpers'],
];

/** "6 steps: 3 commands, 2 files read, Jira", or "2 commands" when that is all they were. */
export function stepsSummary(blocks: readonly Block[]): string {
  const uses = blocks.flatMap((block) => (block.kind === 'tool' && block.use ? [block.use] : []));
  const counts = new Map<string, { n: number; one: string; many: string }>();
  for (const use of uses) {
    const name = gatewayTool(use.name)?.tool ?? use.name;
    const kind = kinds.find(([pattern]) => pattern.test(name));
    if (!kind) continue;
    const [, one, many] = kind;
    const seen = counts.get(one) ?? { n: 0, one, many };
    counts.set(one, { ...seen, n: seen.n + 1 });
  }
  const sorted = [...counts.values()].sort((left, right) => right.n - left.n);
  const said = (item: { n: number; one: string; many: string }) =>
    item.one === item.many ? item.one : `${item.n} ${item.n === 1 ? item.one : item.many}`;
  const only = sorted[0];
  if (sorted.length === 1 && only && only.n === uses.length && only.one !== only.many) {
    return said(only);
  }
  const total = `${uses.length} ${uses.length === 1 ? 'step' : 'steps'}`;
  return sorted.length ? `${total}: ${sorted.slice(0, 3).map(said).join(', ')}` : total;
}

/** A run of calls as one row, which opens to each of them. */
function Steps(props: { blocks: Block[]; auto: boolean; live: boolean; children: ReactNode }) {
  // Until the person opens or closes it, the row follows the run: open while it is the newest.
  const [toggled, setToggled] = useState<boolean>();
  const settled = useContext(Settled);
  const failed = props.blocks.filter((block) => block.kind === 'tool' && block.result?.isError);
  const going =
    props.live && props.blocks.some((block) => block.kind === 'tool' && block.use && !block.result);
  return (
    <Disclosure
      open={toggled ?? props.auto}
      onToggle={setToggled}
      summary={
        <>
          <span className="min-w-0 truncate text-ink-2">{stepsSummary(props.blocks)}</span>{' '}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-small">
            {failed.length > 0 &&
              (settled ? (
                <span className="text-ink-3">{failed.length} failed</span>
              ) : (
                <>
                  <StatusMarker status="failed" />
                  <span className="text-failed">{failed.length} failed</span>
                </>
              ))}
            {going && (
              <>
                <StatusMarker status="running" />
                <span className="sr-only">Running</span>
              </>
            )}
          </span>
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 border-l border-line pl-3">
        {props.children}
      </div>
    </Disclosure>
  );
}

/** Where the final answer was: it heads the page, under Result. */
function AnswerAbove() {
  return (
    <p className="text-small text-ink-3">
      The final answer is under{' '}
      <a
        href="#final-answer"
        className="text-ink-2 underline underline-offset-2 hover:text-ink"
        onClick={(event) => jumpTo(event, 'final-answer')}
      >
        Result
      </a>
      .
    </p>
  );
}

function Entry({ block, live, usage }: { block: Block; live: boolean; usage?: string }) {
  if (block.kind === 'tool') {
    return <ToolCall use={block.use} result={block.result} live={live} usage={usage} />;
  }
  if (block.kind === 'usage') return null;
  if (block.kind === 'system') return <SystemEvents events={block.events} />;
  if (block.kind === 'result') return <Result event={block.event} repeats={block.repeats} />;
  const { event } = block;
  if (event.type === 'assistant_message') return <Message text={event.text} />;
  if (event.type === 'unknown') return <Unknown rawType={event.rawType} raw={event.raw} />;
  if (event.type === 'started') {
    return (
      <Quiet>
        Claude Code{event.cliVersion && ` ${event.cliVersion}`} started
        {event.model && (
          <>
            {' '}
            with <code>{event.model}</code>
          </>
        )}
      </Quiet>
    );
  }
  // The code is for whoever reads the logs; the message usually names it already.
  const code = !event.message.includes(event.code) && (
    <>
      {' '}
      <code className="text-ink-3">{event.code}</code>
    </>
  );
  if (!event.fatal) {
    return (
      <Quiet>
        {event.message}
        {code}
      </Quiet>
    );
  }
  const cancelled = event.code === 'cancelled';
  return (
    <div className="flex items-start gap-2.5 border-t border-line pt-3">
      <StatusMarker status={cancelled ? 'cancelled' : 'failed'} className="mt-[3px]" />
      {/* The message may end with what the CLI printed: an API error's JSON, a request id. */}
      <p className="min-w-0 wrap-anywhere">
        <span className={cn('font-medium', !cancelled && 'text-failed')}>{event.message}</span>
        {code}
      </p>
    </div>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-small text-ink-3 wrap-anywhere">{children}</p>
);

// Memoized by its text: a long run re-folds on every event, and markdown is the costly part.
const Message = memo(function Message({ text }: { text: string }) {
  return <Markdown>{text}</Markdown>;
});

function Result({ event, repeats }: { event: Of<'result'>; repeats: boolean }) {
  return (
    <div className="border-t border-line pt-3">
      <p className="flex items-center gap-2 font-medium">
        <StatusMarker status={event.isError ? 'failed' : 'done'} />
        {event.isError ? 'Claude Code finished with an error' : 'Claude Code finished'}
      </p>
      {!repeats && event.text.trim() && <Markdown className="mt-2">{event.text}</Markdown>}
    </div>
  );
}

// The argument a person recognizes a call by: the command, the file, the pattern.
const telling = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'title',
  'branch',
  'description',
];

// A run's workspace is <home>/runs/<id>/repo: inside it, a path reads from the repository, so
// a row shows the file and not the folder it truncates into.
const workspacePath = /^.*\/runs\/[0-9a-f-]{36}\/repo\//;

/** One line of a tool's arguments, for its row. */
export function preview(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const name = telling.find((field) => typeof record[field] === 'string');
    if (name) return String(record[name]).replace(workspacePath, '');
  }
  return JSON.stringify(input) ?? '';
}

/** A tool as a person reads it: the gateway's in its catalog's words (code_host.open_change_request). */
export function toolName(name: string): string {
  const gateway = gatewayTool(name);
  return gateway ? gateway.tool.replace(/^code_host_/, 'code_host.') : name;
}

// What the agent did, in words, and the thing it did it to: a path or a command is set as
// code, a title as text. [verb, the argument that names the thing, as code?]
const verbs: Record<string, [string, string | null, boolean]> = {
  Bash: ['Ran', 'command', true],
  Read: ['Read', 'file_path', true],
  Edit: ['Changed', 'file_path', true],
  MultiEdit: ['Changed', 'file_path', true],
  Write: ['Wrote', 'file_path', true],
  NotebookEdit: ['Changed', 'notebook_path', true],
  Glob: ['Looked for files', 'pattern', true],
  Grep: ['Searched the code for', 'pattern', true],
  LS: ['Listed', 'path', true],
  WebFetch: ['Fetched', 'url', true],
  WebSearch: ['Searched the web for', 'query', false],
  TodoWrite: ['Updated its to-do list', null, false],
  TaskCreate: ['Added to its plan', 'subject', false],
  TaskUpdate: ['Updated its plan', null, false],
  TaskList: ['Read its plan', null, false],
  TaskGet: ['Read its plan', null, false],
  ToolSearch: ['Loaded tools', 'query', true],
  Task: ['Started a helper to', 'description', false],
  Agent: ['Started a helper to', 'description', false],
  code_host_open_change_request: ['Opened a change request', 'title', false],
  code_host_create_branch: ['Created the branch', 'branch', true],
  code_host_reply_to_review: ['Replied on the review', null, false],
  code_host_get_change_request: ['Read the change request', null, false],
  code_host_get_pipeline_failures: ['Read the pipeline failures', null, false],
};

/**
 * A call as the owner reads it: what the agent did, then what to. A shell command carries
 * Claude Code's own description of it when there is one ("Run the retry test 20 times"); the
 * command itself stays the thing. A tool nobody named here is "Used", with its first argument.
 */
export function words(use: Pick<Of<'tool_use'>, 'name' | 'input'>): {
  verb: string;
  object: string;
  code: boolean;
} {
  const bare = gatewayTool(use.name)?.tool ?? use.name;
  const known = verbs[bare];
  const number = field(use.input, 'number');
  const at = typeof number === 'number' ? ` #${number}` : '';
  if (!known) return { verb: `Used ${toolName(use.name)}`, object: preview(use.input), code: true };
  const [verb, argument, code] = known;
  const description = bare === 'Bash' ? field(use.input, 'description') : undefined;
  const value = argument ? field(use.input, argument) : undefined;
  const object = typeof value === 'string' ? value.replace(workspacePath, '') : '';
  if (typeof description === 'string' && description) return { verb: description, object, code };
  return { verb: `${verb}${at}`, object, code };
}

/** Under a gateway call whose policy asked the owner: the wait, then who decided and why. */
function Decision({ call }: { call?: ToolCallDecision }) {
  if (!call || call.decision === 'allowed') return null;
  const by = call.decidedBy ? ` by ${call.decidedBy.name}` : '';
  if (call.decision === 'pending') {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 pl-5.5 text-small text-ink-2">
        <StatusMarker status="waiting_approval" />
        Waiting for the owner's approval
      </p>
    );
  }
  const why = call.reason ? `: ${call.reason.replace(/\.$/, '')}` : '';
  return (
    <p className="mt-1.5 pl-5.5 text-small text-ink-3 wrap-anywhere">
      {`${call.decision === 'approved' ? 'Approved' : 'Denied'}${by}${why}`}
    </p>
  );
}

const ToolCall = memo(function ToolCall(props: {
  use?: Of<'tool_use'>;
  result?: Of<'tool_result'>;
  live: boolean;
  /** The turn's tokens, when the call ended its turn. */
  usage?: string;
}) {
  const { use, result } = props;
  const settled = useContext(Settled);
  const name = use ? toolName(use.name) : 'Tool result';
  const said = use ? words(use) : { verb: 'Tool result', object: '', code: false };
  return (
    <Disclosure
      summary={
        <>
          {/* The spaces are for the button's name; flex lays the parts out apart anyway. */}
          <span className="shrink-0 font-medium text-ink">{said.verb}</span>{' '}
          {said.code ? (
            <code className="min-w-0 truncate text-ink-2">{said.object}</code>
          ) : (
            <span className="min-w-0 truncate text-ink-2">{said.object}</span>
          )}{' '}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-small">
            {result?.isError ? (
              settled ? (
                <span className="text-ink-3">Error</span>
              ) : (
                <>
                  <StatusMarker status="failed" />
                  <span className="text-failed">Error</span>
                </>
              )
            ) : result ? null : props.live ? (
              <>
                <StatusMarker status="running" />
                <span className="sr-only">Running</span>
              </>
            ) : (
              <span className="text-ink-3">No result</span>
            )}
          </span>
        </>
      }
    >
      {/* The machinery, for whoever needs it: the tool's name and what the turn cost. */}
      {use && (
        <Quiet>
          <code>{name}</code>
          {props.usage && ` · ${props.usage}`}
        </Quiet>
      )}
      {use && <Input name={name} input={use.input} />}
      {result && (
        <Literal label={`Output of ${name}`} heading={result.isError ? 'Error' : 'Output'}>
          {result.output || 'No output'}
        </Literal>
      )}
    </Disclosure>
  );
});

/** A lead's Agent call that gives work to a member of its team, before the member says a word. */
export const assigns = (use: Of<'tool_use'> | undefined, team: readonly TeamMember[]) =>
  (use?.name === 'Agent' || use?.name === 'Task') &&
  team.some((member) => member.key === field(use.input, 'subagent_type'));

/**
 * The lead's assignment to a team member: who, what for and how many steps it took,
 * opening to the assignment and the member's own transcript, its report last.
 */
function Assignment(props: {
  block: Extract<Block, { kind: 'tool' }>;
  live: boolean;
  team: readonly TeamMember[];
  decisions: ReadonlyMap<number, ToolCallDecision>;
  /** Members whose step waits for the owner's approval. */
  waiting: ReadonlySet<string>;
}) {
  const { use, result, children = [] } = props.block;
  const key = field(use?.input, 'subagent_type');
  const member = props.team.find((item) => item.key === key);
  const name = member?.name ?? String(key ?? 'Helper');
  const held =
    props.live && !result && children.length === 0 && props.waiting.has(member?.agentId ?? '');
  const what = field(use?.input, 'description');
  const prompt = field(use?.input, 'prompt');
  const steps = children.filter((event) => event.type === 'tool_use').length;
  const took =
    use && result && formatDuration(new Date(result.at).getTime() - new Date(use.at).getTime());
  return (
    <Disclosure
      summary={
        <>
          {member && <AgentTile id={member.agentId} name={member.name} />}
          <span className="shrink-0 font-medium text-ink">{name}</span>{' '}
          <span className="min-w-0 truncate text-ink-2">
            {typeof what === 'string' ? what : ''}
          </span>{' '}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-small text-ink-3">
            {!held && `${steps} ${steps === 1 ? 'step' : 'steps'}`}
            {took && ` · ${took}`}
            {result?.isError ? (
              <StatusMarker status="failed" />
            ) : result ? (
              <StatusMarker status="done" />
            ) : held ? (
              <>
                <StatusMarker status="waiting_approval" />
                <span>Waiting for approval</span>
              </>
            ) : (
              !result && props.live && <StatusMarker status="running" />
            )}
          </span>
        </>
      }
    >
      {typeof prompt === 'string' && (
        <Literal label={`Assignment of ${name}`} heading="Assignment">
          {prompt}
        </Literal>
      )}
      <div className="border-l border-line pl-4">
        <Transcript
          events={children}
          live={props.live && !result}
          team={props.team}
          decisions={props.decisions}
        />
      </div>
      {result?.isError && (
        <Literal label={`Error of ${name}`} heading="Error">
          {result.output || 'No output'}
        </Literal>
      )}
    </Disclosure>
  );
}

/**
 * A call's arguments. A shell command is shown as the text it is, with the call's description
 * over it, rather than as JSON with its newlines escaped: a heredoc commit message reads as it
 * was written; what else the call set (a timeout, the background) follows as JSON. Every other
 * tool keeps its JSON, whose keys say what each value is.
 */
function Input({ name, input }: { name: string; input: unknown }) {
  const command = name === 'Bash' ? field(input, 'command') : undefined;
  if (typeof command === 'string') {
    const { description, ...options } = input as Record<string, unknown>;
    delete options.command;
    const heading = typeof description === 'string' && description ? description : 'Command';
    return (
      <>
        <Literal label={`Command of ${name}`} heading={heading}>
          {command}
        </Literal>
        {Object.keys(options).length > 0 && (
          <Literal label={`Options of ${name}`} heading="Options">
            {JSON.stringify(options, null, 2)}
          </Literal>
        )}
      </>
    );
  }
  return (
    <Literal label={`Input of ${name}`} heading="Input">
      {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
    </Literal>
  );
}

function Unknown({ rawType, raw }: { rawType: string; raw: unknown }) {
  return (
    <Disclosure quiet summary={<code className="truncate text-ink-3">{rawType}</code>}>
      <Literal label={`Event ${rawType}`}>{JSON.stringify(raw, null, 2) ?? ''}</Literal>
    </Disclosure>
  );
}

/** Claude Code's housekeeping during the run: one line, each event inside it as it came. */
function SystemEvents({ events }: { events: Of<'unknown'>[] }) {
  return (
    <Disclosure
      quiet
      summary={
        <span className="text-ink-3">
          {events.length} system {events.length === 1 ? 'event' : 'events'}
        </span>
      }
    >
      <ul className="grid grid-cols-[minmax(0,1fr)]">
        {events.map((event) => (
          <li key={event.seq}>
            <Unknown rawType={event.rawType} raw={event.raw} />
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/** A row that opens to what it summarizes; the body exists only while open. */
export function Disclosure(props: {
  summary: ReactNode;
  children: ReactNode;
  /** Controlled: whether it is open, and what a click asks for. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  quiet?: boolean;
  /** Inside a narrow column: the row keeps to its width instead of bleeding 8 px each side. */
  flush?: boolean;
}) {
  const [own, setOwn] = useState(false);
  const open = props.open ?? own;
  const setOpen = props.onToggle ?? setOwn;
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex min-w-0 items-center gap-2 rounded-md text-left hover:bg-hover',
          props.flush ? 'w-full' : '-mx-2 w-[calc(100%+16px)] px-2',
          props.quiet ? 'h-6 text-small' : 'h-8',
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-ink-3 transition-transform duration-120',
            open && 'rotate-90',
          )}
        />
        {props.summary}
      </button>
      {/* Opens by growing (an outer grid row from 0fr), closes at once. */}
      {open && (
        <div id={id} className="grid animate-unfold">
          <div className="min-h-0 overflow-hidden">
            <div className="mt-1 mb-2 ml-5.5 grid grid-cols-[minmax(0,1fr)] gap-2">
              {props.children}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Machine text as it was: mono, wrapped, scrolling inside itself when long. A token longer than
 * the line (a path, a hash) breaks anywhere rather than widening the column.
 */
function Literal(props: { label: string; heading?: string; children: string }) {
  return (
    <div className="grid gap-1">
      {props.heading && <p className="text-small text-ink-3">{props.heading}</p>}
      {/* Focusable, so that a keyboard can scroll a long output. */}
      <pre
        tabIndex={0}
        aria-label={props.label}
        className="max-h-80 overflow-y-auto rounded-md bg-desk p-3 font-mono text-small wrap-anywhere whitespace-pre-wrap"
      >
        {props.children}
      </pre>
    </div>
  );
}
