import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../ui/cn';
import { StatusMarker } from '../ui/status';
import type { RunEvent, TeamMember, ToolCallDecision } from './run-data';
import { toolName, Transcript } from './transcript';

// The run's plan, as the agent keeps it: its to-do list, each step with what the
// agent did while it was the current one, and while the run goes, what it is doing now. Claude
// Code keeps the list with TodoWrite, or with TaskCreate and TaskUpdate in versions that have
// them; an agent that keeps none shows no plan, and the transcript below has everything.

type Of<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;
type Status = 'pending' | 'in_progress' | 'completed';
export type Step = { content: string; active: string; status: Status; events: RunEvent[] };

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
const statusOf = (value: unknown): Status | undefined =>
  value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined;

/**
 * The plan as its latest update has it, and each step's events: everything that happened, in
 * the lead's run and its members', while that step was the one in progress.
 */
export function planOf(events: readonly RunEvent[]): Step[] {
  let steps: Step[] = [];
  let current: Step | undefined;
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  // A plan tool's own result belongs to no step.
  const planCalls = new Set<string>();
  for (const event of ordered) {
    if (event.type === 'tool_use' && PLAN_TOOLS.has(event.name) && !event.parentToolUseId) {
      planCalls.add(event.id);
      const input = event.input;
      if (event.name === 'TodoWrite') {
        const todos = field(input, 'todos');
        const listed = Array.isArray(todos) ? todos : [];
        // The same step keeps its events across updates: matched by its words.
        steps = listed.map((todo) => {
          const content = text(field(todo, 'content'));
          const before = steps.find((step) => step.content === content);
          return {
            content,
            active: text(field(todo, 'activeForm')) || content,
            status: statusOf(field(todo, 'status')) ?? 'pending',
            events: before?.events ?? [],
          };
        });
      } else if (event.name === 'TaskCreate') {
        const content = text(field(input, 'subject'));
        steps = [
          ...steps,
          {
            content,
            active: text(field(input, 'activeForm')) || content,
            status: 'pending',
            events: [],
          },
        ];
      } else if (event.name === 'TaskUpdate') {
        // Task ids are their order of creation: 1, 2, 3.
        const step = steps[Number(text(field(input, 'taskId')) || field(input, 'taskId')) - 1];
        const status = statusOf(field(input, 'status'));
        if (step && status) step.status = status;
        if (step && field(input, 'status') === 'deleted') steps = steps.filter((s) => s !== step);
      }
      current = steps.find((step) => step.status === 'in_progress');
      continue;
    }
    if (event.type === 'tool_result' && planCalls.has(event.toolUseId)) continue;
    if (event.type === 'usage' || event.type === 'started') continue;
    current?.events.push(event);
  }
  return steps.filter((step) => step.content);
}

// A call while it runs, in the present: the transcript says what it did once it is done.
const present: Record<string, [string, string | null]> = {
  Read: ['Reading', 'file_path'],
  Edit: ['Editing', 'file_path'],
  MultiEdit: ['Editing', 'file_path'],
  Write: ['Writing', 'file_path'],
  NotebookEdit: ['Editing', 'notebook_path'],
  Grep: ['Searching for', 'pattern'],
  Glob: ['Looking for', 'pattern'],
  Bash: ['Running', 'command'],
  WebFetch: ['Reading', 'url'],
  WebSearch: ['Searching the web for', 'query'],
  Agent: ['Waiting for', 'subagent_type'],
  Task: ['Waiting for', 'subagent_type'],
};

function now(use: Of<'tool_use'>): string {
  // A command the agent described is said by its description, not the command line.
  const described = text(field(use.input, 'description'));
  if (use.name === 'Bash' && described) return described;
  const known = present[use.name];
  if (!known) return `Using ${toolName(use.name)}`;
  const [verb, argument] = known;
  const value = argument ? text(field(use.input, argument)) : '';
  // Under the run's workspace a path reads from the repository's root.
  return value ? `${verb} ${value.replace(/^.*\/runs\/[^/]+\/repo\//, '')}` : verb;
}

/**
 * What the agent is at now: the call still running, said as the transcript says it, else the
 * step in progress, else thinking. The step is already in the list above; the call is news.
 */
export function doing(events: readonly RunEvent[], steps: Step[]): string {
  const top = events.filter((event) => !('parentToolUseId' in event && event.parentToolUseId));
  const last = top.at(-1);
  if (last?.type === 'tool_use' && !PLAN_TOOLS.has(last.name)) {
    const done = top.some((event) => event.type === 'tool_result' && event.toolUseId === last.id);
    if (!done) {
      return now(last as Of<'tool_use'>);
    }
  }
  return steps.find((one) => one.status === 'in_progress')?.active ?? 'Thinking';
}

export function RunPlan(props: {
  events: readonly RunEvent[];
  /** planOf(events), which the run page needs too. */
  steps: Step[];
  live: boolean;
  toolCalls?: readonly ToolCallDecision[];
  team?: readonly TeamMember[];
}) {
  const { steps } = props;
  const done = steps.filter((step) => step.status === 'completed').length;
  if (steps.length === 0 && !props.live) return null;
  // The step in progress is marked in the list: said again under it, it read as one step more.
  const now = doing(props.events, steps);
  const news = now !== steps.find((one) => one.status === 'in_progress')?.active;
  return (
    <section aria-labelledby="plan" className="mb-8 grid max-w-205 grid-cols-[minmax(0,1fr)] gap-2">
      {steps.length > 0 && (
        <>
          <div className="flex items-baseline gap-3">
            <h2 id="plan" className="text-section">
              Plan
            </h2>
            <span className="text-small text-ink-3">
              {done} of {steps.length} done
            </span>
          </div>
          <ol className="grid grid-cols-[minmax(0,1fr)]">
            {steps.map((step, index) => (
              <PlanStep
                key={`${index}-${step.content}`}
                step={step}
                live={props.live}
                toolCalls={props.toolCalls}
                team={props.team}
              />
            ))}
          </ol>
        </>
      )}
      {props.live && news && (
        <p role="status" className="flex min-w-0 items-center gap-2.5 text-ink-2">
          <StatusMarker status="running" />
          <span className="truncate">{now}…</span>
        </p>
      )}
    </section>
  );
}

function PlanStep(props: {
  step: Step;
  live: boolean;
  toolCalls?: readonly ToolCallDecision[];
  team?: readonly TeamMember[];
}) {
  const { step } = props;
  const [open, setOpen] = useState(false);
  // What the agent did in the step: its calls and what it wrote, not their results.
  const inside = step.events.filter(
    (event) => event.type === 'tool_use' || event.type === 'assistant_message',
  ).length;
  const marker =
    step.status === 'completed'
      ? 'done'
      : step.status === 'in_progress' && props.live
        ? 'running'
        : 'queued';
  return (
    <li className="border-b border-line">
      <button
        type="button"
        aria-expanded={open}
        disabled={inside === 0}
        onClick={() => setOpen((was) => !was)}
        className="flex min-h-10 w-full min-w-0 items-center gap-2.5 py-2 text-left disabled:cursor-default"
      >
        <StatusMarker status={marker} />
        <span
          className={cn(
            'min-w-0 flex-1',
            step.status === 'completed' && 'text-ink-2',
            step.status === 'in_progress' && 'font-medium',
          )}
        >
          {step.status === 'in_progress' && props.live ? step.active : step.content}
        </span>
        {inside > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-small text-ink-3">
            {inside} {inside === 1 ? 'action' : 'actions'}
            <ChevronRight
              aria-hidden="true"
              className={cn('size-3.5 transition-transform duration-120', open && 'rotate-90')}
            />
          </span>
        )}
      </button>
      {open && (
        <div className="pb-4 pl-6">
          <Transcript
            events={step.events}
            live={props.live && step.status === 'in_progress'}
            toolCalls={props.toolCalls}
            team={props.team}
          />
        </div>
      )}
    </li>
  );
}
