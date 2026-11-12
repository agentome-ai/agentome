import { cn } from '../ui/cn';
import { AgentTile, tintOf } from '../ui/tint';
import { formatDuration, type RunDetail, type RunEvent, type TeamMember } from './run-data';
import { assigns } from './transcript';

// Who of a team took part in its run and when. The members work as subagents inside the
// lead's run, so Runs lists the lead alone: here the run's own events tell them apart,
// each assignment from the lead's call that gave it to the call's result.

type Of<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

/** A stretch of work, in ms from the run's start; a member's carries its assignment. */
export type Stint = { from: number; to: number; what?: string; steps?: number };
export type Lane = { id: string; name: string; stints: Stint[]; lead?: true };
export type TeamWork = {
  /** The run's length in ms, from its start to its end, or to now while it goes. */
  total: number;
  /** The lead first, then each member that took part, in the team's order. */
  lanes: Lane[];
  /** The members the lead never called. */
  idle: TeamMember[];
};

const time = (iso: string) => new Date(iso).getTime();
const text = (value: unknown, name: string) => {
  const found = typeof value === 'object' && value ? (value as Record<string, unknown>)[name] : '';
  return typeof found === 'string' ? found : '';
};
// A gap between two assignments shorter than this is the lead passing the work on, not working.
const PAUSE_MS = 5_000;

export function teamWork(
  run: Pick<RunDetail, 'agent' | 'team' | 'startedAt' | 'endedAt'>,
  events: readonly RunEvent[],
  live: boolean,
  now: number,
): TeamWork | undefined {
  const team = run.team ?? [];
  if (team.length === 0) return undefined;
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const first = ordered[0];
  const last = ordered.at(-1);
  const start = run.startedAt ? time(run.startedAt) : first ? time(first.at) : now;
  const end = run.endedAt ? time(run.endedAt) : live ? now : last ? time(last.at) : start;
  const total = Math.max(0, end - start);
  const at = (ms: number) => Math.min(total, Math.max(0, ms - start));

  const results = new Map<string, Of<'tool_result'>>();
  const children = new Map<string, RunEvent[]>();
  for (const event of ordered) {
    const parent = 'parentToolUseId' in event ? event.parentToolUseId : undefined;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), event]);
    else if (event.type === 'tool_result') results.set(event.toolUseId, event);
  }

  const byMember = new Map<string, Stint[]>();
  for (const event of ordered) {
    if (event.type !== 'tool_use' || event.parentToolUseId || !assigns(event, team)) continue;
    const key = text(event.input, 'subagent_type');
    const inside = children.get(event.id) ?? [];
    const result = results.get(event.id);
    // Unfinished: still going while the run is, or cut off at the member's last word.
    const ended = result ? time(result.at) : live ? now : time((inside.at(-1) ?? event).at);
    byMember.set(key, [
      ...(byMember.get(key) ?? []),
      {
        from: at(time(event.at)),
        to: at(ended),
        what: text(event.input, 'description'),
        steps: inside.filter((child) => child.type === 'tool_use').length,
      },
    ]);
  }

  // The lead works whenever none of its members does.
  const busy = [...byMember.values()].flat().sort((left, right) => left.from - right.from);
  const lead: Stint[] = [];
  let free = 0;
  for (const stint of busy) {
    if (stint.from - free >= PAUSE_MS) lead.push({ from: free, to: stint.from });
    free = Math.max(free, stint.to);
  }
  if (total - free >= PAUSE_MS || lead.length === 0) lead.push({ from: free, to: total });

  return {
    total,
    lanes: [
      { id: run.agent.id, name: run.agent.name, stints: lead, lead: true },
      ...team.flatMap((member) => {
        const stints = byMember.get(member.key);
        return stints ? [{ id: member.agentId, name: member.name, stints }] : [];
      }),
    ],
    idle: team.filter((member) => !byMember.has(member.key)),
  };
}

const sum = (stints: readonly Stint[]) =>
  stints.reduce((total, stint) => total + stint.to - stint.from, 0);

/** "4× · 38 steps · 25 min" for a member, the minutes alone for the lead. */
function laneMeta(lane: Lane) {
  const minutes = formatDuration(sum(lane.stints));
  if (lane.lead) return minutes;
  const steps = lane.stints.reduce((total, stint) => total + (stint.steps ?? 0), 0);
  return `${lane.stints.length}× · ${steps} ${steps === 1 ? 'step' : 'steps'} · ${minutes}`;
}

// The axis is in round minutes: at most five steps of it over the run.
const STEPS_MIN = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360];
function ticksOf(total: number): number[] {
  const minutes = total / 60_000;
  const step = STEPS_MIN.find((one) => minutes / one <= 5) ?? Math.ceil(minutes / 5 / 60) * 60;
  return Array.from({ length: Math.floor(minutes / step) + 1 }, (_, i) => i * step * 60_000);
}
const tickLabel = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes === 0) return '0';
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
};

// A phone puts the bar under the name and the numbers; a wide screen puts it between them.
const row =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 md:grid-cols-[10rem_minmax(0,1fr)_9.5rem]';
const bar = 'relative col-span-2 row-start-2 md:col-span-1 md:col-start-2 md:row-start-1';

/** The Team section over a team run's transcript: a lane per participant on the run's time. */
export function RunTeam({ work, live }: { work: TeamWork; live: boolean }) {
  const { total, lanes, idle } = work;
  const ticks = ticksOf(total);
  const left = (ms: number) => `${total > 0 ? (ms / total) * 100 : 0}%`;
  return (
    <section aria-labelledby="team" className="mb-8 grid max-w-205 grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id="team" className="text-section">
          Team
        </h2>
        <span className="text-small text-ink-3">
          {lanes.length - 1} of {lanes.length - 1 + idle.length}
          <span className="max-md:hidden"> took part</span>
        </span>
      </div>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 md:gap-2.5">
        {lanes.map((lane) => (
          <li key={lane.id} className={row}>
            <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 font-medium">
              <AgentTile id={lane.id} name={lane.name} />
              <span className="truncate">{lane.name}</span>
            </span>
            <span className="col-start-2 row-start-1 text-right text-small whitespace-nowrap text-ink-3 tabular-nums md:col-start-3">
              {laneMeta(lane)}
            </span>
            <div
              aria-hidden="true"
              className={cn(bar, 'h-3.5 rounded bg-selected', tintOf(lane.id))}
            >
              {ticks.slice(1).map((tick) => (
                <i
                  key={tick}
                  className="absolute -inset-y-[3px] w-px bg-line-strong"
                  style={{ left: left(tick) }}
                />
              ))}
              {lane.stints.map((stint, i) => (
                <span
                  key={i}
                  title={
                    stint.what
                      ? `${stint.what}, ${formatDuration(stint.to - stint.from)}`
                      : undefined
                  }
                  className={cn(
                    'absolute inset-y-0 rounded',
                    lane.lead ? 'bg-current/55' : 'bg-current',
                  )}
                  style={{
                    left: left(stint.from),
                    width: `max(3px, ${left(stint.to - stint.from)})`,
                  }}
                />
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div aria-hidden="true" className={cn(row, '-mt-1')}>
        <div className={cn(bar, 'row-start-1 h-4 text-small text-ink-3 tabular-nums')}>
          {ticks.map((tick) => {
            const share = total > 0 ? tick / total : 0;
            return (
              <span
                key={tick}
                className={cn(
                  'absolute whitespace-nowrap',
                  share === 0 ? '' : share > 0.9 ? '-translate-x-full' : '-translate-x-1/2',
                )}
                style={{ left: left(tick) }}
              >
                {tickLabel(tick)}
              </span>
            );
          })}
        </div>
      </div>
      {idle.length > 0 && (
        <p className="flex min-w-0 items-center gap-2 text-small text-ink-3">
          <span aria-hidden="true" className="flex shrink-0 gap-1 opacity-50">
            {idle.map((member) => (
              <AgentTile key={member.key} id={member.agentId} name={member.name} />
            ))}
          </span>
          <span className="min-w-0">
            {live ? 'Not called yet' : 'Not called in this run'}:{' '}
            {idle.map((member) => member.name).join(', ')}
          </span>
        </p>
      )}
    </section>
  );
}

/** The run's facts' Team: the tiles of the members that took part, their names to a reader. */
export function TeamTiles({ work }: { work: TeamWork }) {
  const members = work.lanes.filter((lane) => !lane.lead);
  const names = members.map((lane) => lane.name).join(', ');
  return (
    <span className="flex items-center gap-1 py-0.5" title={names}>
      {members.map((lane) => (
        <AgentTile key={lane.id} id={lane.id} name={lane.name} />
      ))}
      <span className="sr-only">{names}</span>
    </span>
  );
}
