import { ChevronRight, Lock } from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '../ui/button';
import { Chip } from '../ui/chip';
import { cn } from '../ui/cn';
import { HostGlyph, type Host, hostName } from '../ui/host-glyph';
import { Status, statusLabel, type RunStatus } from '../ui/status';

export type Policy = 'allow' | 'ask' | 'deny';
export type AccessLevel = 'owner' | 'deputy' | 'operator' | 'viewer';
export type SheetAction =
  'run' | 'duplicate' | 'export' | 'preview' | 'transfer' | 'archive' | 'unarchive';

/** Tools grouped by connector; `action` is the human sentence, not the catalog ID. */
export type Connector = {
  name: string;
  hosts?: Host[];
  tools: { action: ReactNode; policy: Policy; platformRule?: boolean; unsaved?: boolean }[];
};

export type AgentSheetProps = {
  /** Short ID that people copy into the API and the management MCP. */
  id: string;
  name: string;
  roleTitle: string;
  owner: string;
  since: string;
  template: { name: string; version: number } | null;
  /** null: the agent has never run. */
  lastRun: { status: RunStatus; when: string } | null;
  seat: { name: string; state: 'busy' | 'ready' | 'offline'; activity?: string } | null;
  projects: { name: string; host?: Host; repository: string }[];
  connectors: Connector[];
  /** `until`: has the agent until that day; `from`: gets it back on that day. */
  people: { name: string; level: AccessLevel; until?: string; from?: string }[];
  /** Monthly limit in USD; null: no budget set. */
  budget: number | null;
  /** null: no runs yet, so there is nothing to estimate from. */
  spend: { month: number; perTask: [number, number] | null; runs?: number } | null;
  skills: { name: string; version: string; privateTo?: string }[];
  memoryDocuments: number;
  /** The page has unsaved edits: Save changes in its header is the primary button, Run here is not. */
  unsavedChanges?: boolean;
  /** An archived agent: Archive becomes Unarchive. */
  archived?: boolean;
  /** Actions that can't be taken yet, each with the reason shown under its row of buttons. */
  unavailable?: Partial<Record<SheetAction, string>>;
  onAction?: (action: SheetAction) => void;
  /** Placement, e.g. sticky with a max height: the panel then scrolls inside itself. */
  className?: string;
};

const policies = ['allow', 'ask', 'deny'] as const;
const policyWord = { allow: 'can', ask: 'ask owner', deny: 'never' };
// Normal is quiet: "can" is the control gray, the human gate is Sign-off, "never" the ink stop.
const policyColor = { allow: 'bg-line-control', ask: 'bg-accent', deny: 'bg-ink' };
// The weight of the ring follows the weight of the access.
const levelRing = {
  owner: 'bg-ink text-ink-inverse',
  deputy: 'text-ink inset-ring-[1.5px] inset-ring-ink',
  operator: 'inset-ring inset-ring-line-control',
  viewer: 'border border-dashed border-line-control',
};
const seatDot = { busy: 'bg-running', ready: 'bg-mark-muted', offline: 'border border-mark-muted' };
// A revision bar on the margin, as in a marked-up contract: this line has an unsaved change.
const changeBar =
  'relative before:absolute before:left-[calc(6px-var(--sheet-pad))] before:w-0.5 before:rounded-full before:bg-ink-2';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  trailingZeroDisplay: 'stripIfInteger',
});
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The agent sheet: a pass, not a profile. One tree, two densities: the pass by default, the
 * compact rows when the panel is narrower than 360 px (a container query, index.css) or when the
 * pass would be taller than the window. People never pick the density.
 */
export function AgentSheet(props: AgentSheetProps) {
  const { connectors, people, projects, skills, budget, spend, onAction } = props;
  const unavailable = props.unavailable ?? {};
  const reasons = useId();
  // A button of the sheet; one that can't be used yet points at its reason.
  const action = (name: SheetAction, label: string, variant?: 'primary' | 'quiet') => (
    <Button
      variant={variant}
      disabled={unavailable[name] !== undefined}
      aria-describedby={unavailable[name] && `${reasons}-${name}`}
      onClick={() => onAction?.(name)}
    >
      {label}
    </Button>
  );
  const reasonsFor = (names: SheetAction[]) =>
    names.flatMap((name) =>
      unavailable[name] ? (
        <p key={name} id={`${reasons}-${name}`} className="mt-1.5 text-small text-ink-3">
          {unavailable[name]}
        </p>
      ) : (
        []
      ),
    );
  const panel = useRef<HTMLElement>(null);
  // Lists people opened; while one is open the sheet keeps its density (see the hook).
  const openLists = useRef(0);
  const onToggle = (open: boolean) => (openLists.current += open ? 1 : -1);
  const tall = useTallerThanWindow(panel, openLists);
  const tools = connectors.flatMap((connector) => connector.tools);
  const counts = { allow: 0, ask: 0, deny: 0 };
  for (const tool of tools) counts[tool.policy] += 1;
  const inRun = [
    'CLAUDE.md',
    plural(skills.length, 'skill'),
    plural(counts.allow + counts.ask, 'tool'),
    plural(props.memoryDocuments, 'memory document'),
  ].filter((part) => !part.startsWith('0 '));
  const privateSkills = skills.filter((skill) => skill.privateTo).length;

  return (
    <div
      data-density={tall ? 'compact' : 'pass'}
      className={cn('@container/sheet', props.className)}
    >
      <aside
        ref={panel}
        aria-label={`Agent sheet: ${props.name}`}
        className="max-h-[inherit] overflow-y-auto overscroll-contain rounded-xl border border-line-strong bg-raised p-(--sheet-pad) [--sheet-pad:20px] compact:[--sheet-pad:16px]"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-name compact:text-title">{props.name}</h2>
          <code
            title="Agent ID for the API and the management MCP"
            className="text-[11.5px] text-ink-3"
          >
            {props.id}
          </code>
        </div>
        <p className="mt-0.5 text-ink-2">{props.roleTitle}</p>

        <dl className="mt-3.5 grid grid-cols-2 border-t border-line compact:mt-3 compact:grid-cols-1 compact:gap-1.5 compact:border-0">
          <Field label="Owner" className="pr-3">
            {props.owner}
          </Field>
          <Field label="Since" className="border-l pl-3">
            {props.since}
          </Field>
          <Field label="Template" className="pr-3">
            {props.template ? `${props.template.name} ` : <Quiet>None</Quiet>}
            {props.template && <Quiet>v{props.template.version}</Quiet>}
          </Field>
          <Field label="Last run" className="border-l pl-3">
            {props.lastRun ? (
              <Status status={props.lastRun.status}>
                {statusLabel[props.lastRun.status]}, {props.lastRun.when}
              </Status>
            ) : (
              <Quiet>Never run</Quiet>
            )}
          </Field>
          <Field label="Runs on" className="col-span-2">
            {props.seat ? (
              <span className="flex items-center gap-2">
                <Chip title={props.seat.activity}>
                  <span className={cn('size-2 rounded-full', seatDot[props.seat.state])} />
                  {props.seat.name}
                </Chip>
                <Quiet>{capital(props.seat.state)}</Quiet>
              </span>
            ) : (
              <Quiet>No computer connected</Quiet>
            )}
          </Field>
          <Field label="Works on" className="col-span-2 compact:hidden">
            <Projects projects={projects} />
          </Field>
        </dl>

        <div className="mt-3.5 flex flex-wrap gap-2">
          {action('run', 'Run', props.unsavedChanges ? undefined : 'primary')}
          {action('duplicate', 'Duplicate')}
          {action('export', 'Export')}
        </div>
        {reasonsFor(['run', 'duplicate', 'export'])}

        <p className="mt-5.5 mb-2 text-small font-medium text-ink-2">
          <b className="text-ui font-semibold text-ink">{tools.length}</b>{' '}
          {tools.length === 1 ? 'tool' : 'tools'}
        </p>
        {tools.length > 0 && (
          <>
            <div
              role="img"
              aria-label={`${plural(tools.length, 'tool')}: ${policies.map((p) => `${counts[p]} ${policyWord[p]}`).join(', ')}`}
              className="flex h-2 gap-0.5"
            >
              {policies
                .filter((policy) => counts[policy] > 0)
                .map((policy) => (
                  <span
                    key={policy}
                    title={`${counts[policy]} ${policyWord[policy]}`}
                    className={cn('min-w-1 last:rounded-r-sm', policyColor[policy])}
                    style={{ flexGrow: counts[policy] }}
                  />
                ))}
            </div>
            <ul
              aria-hidden="true"
              className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-small text-ink-2"
            >
              {policies.map((policy) => (
                <li key={policy} className="inline-flex items-center gap-1.5">
                  <span className={cn('h-2 w-2.5 rounded-[2px]', policyColor[policy])} />
                  <b className="text-ui font-semibold text-ink">{counts[policy]}</b>
                  {policyWord[policy]}
                </li>
              ))}
            </ul>
            <Part
              onToggle={onToggle}
              label="Connectors"
              unsaved={tools.some((tool) => tool.unsaved)}
              className="mt-0 compact:mt-4.5"
              value={connectors
                .slice(0, 2)
                .map((connector) => connector.name)
                .concat(connectors.length > 2 ? [`+${connectors.length - 2}`] : [])
                .join(', ')}
            >
              <ToolDetails connectors={connectors} total={tools.length} onToggle={onToggle} />
            </Part>
          </>
        )}
        <Part
          onToggle={onToggle}
          label="Works on"
          className="hidden compact:block"
          value={
            <>
              {[...new Set(projects.flatMap((project) => project.host ?? []))].map((host) => (
                <HostGlyph key={host} host={host} />
              ))}
              {projects.length ? plural(projects.length, 'project') : 'No projects'}
            </>
          }
        >
          <Projects projects={projects} />
        </Part>
        <Part
          onToggle={onToggle}
          label="Access"
          value={people.map((person) => (
            <Initials key={person.name} name={person.name} level={person.level} small />
          ))}
        >
          <People people={people} />
        </Part>
        <Part
          onToggle={onToggle}
          label="Cost"
          value={
            spend ? (
              <>
                <b className="font-medium">{usd.format(spend.month)}</b>
                {budget !== null && <Meter spent={spend.month} budget={budget} className="w-11" />}
                {budget !== null && <Quiet>of {usd.format(budget)}</Quiet>}
              </>
            ) : (
              'No runs yet'
            )
          }
        >
          <Cost budget={budget} spend={spend} />
        </Part>
        <Part
          onToggle={onToggle}
          label="Knows"
          className="compact:border-b"
          value={
            <>
              {skills.length ? plural(skills.length, 'skill') : 'No skills'}
              {privateSkills > 0 && (
                <Quiet>
                  <Lock aria-hidden="true" className="mr-1 inline size-3" />
                  {privateSkills} private
                </Quiet>
              )}
            </>
          }
        >
          <Skills skills={skills} />
        </Part>

        <Button className="mt-5.5 flex w-full" onClick={() => onAction?.('preview')}>
          Preview workspace
        </Button>
        <p className="mt-2 text-small text-ink-3">
          {inRun.length > 1
            ? `${inRun.slice(0, -1).join(', ')} and ${inRun.at(-1)} go`
            : 'CLAUDE.md goes'}{' '}
          into each run.
        </p>
        <div className="-mx-2.5 mt-3 flex gap-1">
          {action('transfer', 'Transfer ownership', 'quiet')}
          {props.archived
            ? action('unarchive', 'Unarchive', 'quiet')
            : action('archive', 'Archive', 'quiet')}
        </div>
        {reasonsFor(['transfer', 'archive', 'unarchive'])}
      </aside>
    </div>
  );
}

/**
 * True when the pass does not fit the panel's max height (the window, in the editor). Checked
 * after every render, when the panel or the window changes size and when fonts arrive, but never
 * while a list in the sheet is open: an open list is not the height of the pass, and opening
 * "Show all" must not flip the density under the reader's hand.
 */
function useTallerThanWindow(panel: Ref, openLists: { current: number }) {
  const [tall, setTall] = useState(false);
  const last = useRef({ tall: false, passHeight: 0 });
  const check = useCallback(() => {
    const element = panel.current;
    if (!element || openLists.current > 0) return;
    const maxHeight = parseFloat(getComputedStyle(element).maxHeight);
    const state = last.current;
    let next = state.tall;
    if (Number.isNaN(maxHeight)) next = false;
    else if (!state.tall && element.scrollHeight > element.clientHeight + 1) {
      state.passHeight = element.scrollHeight;
      next = true;
    } else if (state.tall && maxHeight >= state.passHeight) next = false;
    if (next !== state.tall) setTall((state.tall = next));
  }, [panel, openLists]);
  useLayoutEffect(check); // every render: new data or an edit can make the pass taller
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    window.addEventListener('resize', check);
    void document.fonts?.ready.then(check);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [panel, check]);
  return tall;
}

type Ref = { current: HTMLElement | null };

const Quiet = ({ children }: { children: ReactNode }) => (
  <span className="text-ink-3">{children}</span>
);

type Slot = { label: string; className?: string; children: ReactNode };
type Toggle = (open: boolean) => void;

function Field(props: Slot) {
  return (
    <div
      className={cn(
        'min-w-0 border-b border-line py-[7px] compact:col-span-1 compact:grid compact:grid-cols-[64px_minmax(0,1fr)] compact:items-center compact:gap-2.5 compact:border-0 compact:p-0',
        props.className,
      )}
    >
      <dt className="text-small text-ink-3">{props.label}</dt>
      <dd className="mt-0.5 truncate compact:mt-0">{props.children}</dd>
    </div>
  );
}

/**
 * One part of the sheet in both densities: in the pass a block under a small heading, always
 * open; in the compact density a row with a glanceable value that opens to the same block.
 */
function Part(props: Slot & { value: ReactNode; unsaved?: boolean; onToggle: Toggle }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div
      className={cn('mt-5.5 compact:mt-0 compact:border-t compact:border-line', props.className)}
    >
      {props.label !== 'Connectors' && (
        <h3 className="mb-2 text-small font-medium text-ink-2 compact:hidden">{props.label}</h3>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          props.onToggle(!open);
        }}
        className={cn(
          '-mx-2 hidden min-h-9 w-[calc(100%+16px)] grid-cols-[72px_minmax(0,1fr)_14px] items-center gap-2 rounded-md px-2 text-left hover:bg-hover compact:grid',
          // The row only shows in the compact density, and so does its bar; ml-2 undoes -mx-2.
          props.unsaved && `${changeBar} before:inset-y-2.5 before:ml-2`,
        )}
      >
        <span className="font-medium text-ink-2">{props.label}</span>
        <span className={cn('flex min-w-0 items-center gap-1.5 truncate', open && 'invisible')}>
          {props.value}
        </span>
        <ChevronRight
          className={cn(
            'size-3.5 text-ink-3 transition-transform duration-120',
            open && 'rotate-90',
          )}
        />
      </button>
      <div id={id} className={cn('compact:pt-0.5 compact:pb-3.5', !open && 'compact:hidden')}>
        {props.children}
      </div>
    </div>
  );
}

function ToolDetails(props: { connectors: Connector[]; total: number; onToggle: Toggle }) {
  const { connectors, total } = props;
  const [all, setAll] = useState(false);
  return (
    <>
      <table className="mt-3 w-full text-left compact:mt-0">
        <thead className="text-small text-ink-3">
          <tr className="h-5.5 border-b border-line">
            <th className="font-normal">
              <span className="sr-only">Connector</span>
            </th>
            <th className="w-14.5 font-normal">Can</th>
            <th className="w-17.5 font-normal">Ask owner</th>
            <th className="w-12 font-normal">Never</th>
          </tr>
        </thead>
        <tbody>
          {connectors.map((connector) => (
            <tr key={connector.name} className="h-7 border-b border-line">
              <th
                scope="row"
                className={cn(
                  'font-normal whitespace-nowrap',
                  connector.tools.some((tool) => tool.unsaved) && `${changeBar} before:inset-y-1.5`,
                )}
              >
                {connector.name}
                {connector.hosts?.map((host) => (
                  <HostGlyph key={host} host={host} className="ml-1" />
                ))}
              </th>
              {policies.map((policy) => {
                const n = connector.tools.filter((tool) => tool.policy === policy).length;
                return (
                  <td
                    key={policy}
                    title={n ? `${connector.name}: ${n} ${policyWord[policy]}` : undefined}
                  >
                    {n > 0 && <span className="sr-only">{n}</span>}
                    {Array.from({ length: n }, (_, i) => (
                      <span
                        key={i}
                        className={cn(
                          'mr-[3px] inline-block size-2 rounded-full',
                          policyColor[policy],
                        )}
                      />
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        aria-expanded={all}
        onClick={() => {
          setAll(!all);
          props.onToggle(!all);
        }}
        className="mt-1.5 -ml-1.5 inline-flex h-7 items-center gap-1 rounded-md pr-2 pl-1 font-medium text-ink-2 hover:bg-hover hover:text-ink"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform duration-120', all && 'rotate-90')}
        />
        {all ? 'Hide the list' : total === 1 ? 'Show the tool' : `Show all ${total} tools`}
      </button>
      {all &&
        connectors.map((connector) => (
          <Fragment key={connector.name}>
            <p className="mt-2.5 text-small text-ink-3">{connector.name}</p>
            <ul>
              {connector.tools.map((tool, i) => (
                <li
                  key={i}
                  className={cn(
                    'flex min-h-5.5 items-center gap-2',
                    tool.unsaved && `${changeBar} before:inset-y-1`,
                  )}
                >
                  <span className={cn('size-2 shrink-0 rounded-full', policyColor[tool.policy])} />
                  <span className="sr-only">{policyWord[tool.policy]}:</span>
                  <span>{tool.action}</span>
                  {tool.policy === 'ask' && (
                    <span className="text-small text-ink-3">Requires approval</span>
                  )}
                  {tool.platformRule && (
                    <span className="text-small text-ink-3">Platform rule</span>
                  )}
                  {tool.unsaved && <span className="text-small text-ink-3">Unsaved</span>}
                </li>
              ))}
            </ul>
          </Fragment>
        ))}
    </>
  );
}

function Projects({ projects }: Pick<AgentSheetProps, 'projects'>) {
  if (projects.length === 0) return <Quiet>No projects</Quiet>;
  return (
    <ul className="mt-0.5 flex flex-wrap gap-1.5">
      {projects.map((project) => (
        <li key={project.repository}>
          <Chip
            title={
              project.host ? `${hostName[project.host]}: ${project.repository}` : project.repository
            }
          >
            {project.host && <HostGlyph host={project.host} />}
            {project.name}
          </Chip>
        </li>
      ))}
    </ul>
  );
}

function Initials({ name, level, small }: { name: string; level: AccessLevel; small?: boolean }) {
  const letters = name.split(/\s+/).map((word) => word.charAt(0));
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full text-[11px] leading-none font-semibold text-ink-2',
        small && 'size-5 text-[8.5px]',
        levelRing[level],
      )}
    >
      {letters.join('').slice(0, 2).toUpperCase()}
    </span>
  );
}

function People({ people }: Pick<AgentSheetProps, 'people'>) {
  return (
    <>
      <ul className="flex flex-wrap gap-x-4 gap-y-2">
        {people.map((person) => (
          <li key={person.name} title={person.name} className="grid justify-items-start gap-1">
            <Initials name={person.name} level={person.level} />
            <span className="text-small text-ink-2">
              <span className="sr-only">{person.name}, </span>
              {capital(person.level)}
              {person.until && <span className="block text-ink-3">until {person.until}</span>}
              {person.from && <span className="block text-ink-3">from {person.from}</span>}
            </span>
          </li>
        ))}
      </ul>
      {people.every((person) => person.level === 'owner') && (
        <p className="mt-2 text-small text-ink-3">Not shared with anyone</p>
      )}
    </>
  );
}

function Meter({ spent, budget, className }: { spent: number; budget: number; className: string }) {
  return (
    <span
      role="meter"
      aria-label="Spent this month"
      aria-valuemin={0}
      aria-valuemax={budget}
      aria-valuenow={spent}
      className={cn('block h-1 shrink-0 overflow-hidden rounded-[2px] bg-line', className)}
    >
      <span
        className={cn('block h-full bg-ink-2', spent > 0 && spent >= budget && 'bg-failed')}
        style={{
          width: `${budget > 0 ? Math.min(spent / budget, 1) * 100 : spent > 0 ? 100 : 0}%`,
        }}
      />
    </span>
  );
}

function Cost({ budget, spend }: Pick<AgentSheetProps, 'budget' | 'spend'>) {
  const limit = budget === null ? null : usd.format(budget);
  return (
    <>
      {spend ? (
        <p className="flex items-baseline gap-1.5">
          <span className="text-section">{usd.format(spend.month)}</span>
          <Quiet>{limit ? `of ${limit} this month` : 'this month'}</Quiet>
        </p>
      ) : (
        <p className="text-ink-2">No runs yet</p>
      )}
      {budget !== null && (
        <Meter spent={spend?.month ?? 0} budget={budget} className="mt-1.5 mb-2" />
      )}
      <p className="flex justify-between gap-2 text-small text-ink-2">
        {spend?.perTask &&
          `${usd.format(spend.perTask[0])}–${usd.format(spend.perTask[1])} per task`}
        {spend?.runs !== undefined && (
          <span className="ml-auto text-ink-3">{plural(spend.runs, 'run')}</span>
        )}
        {!spend && limit && <Quiet>Limit {limit} a month</Quiet>}
      </p>
    </>
  );
}

function Skills({ skills }: Pick<AgentSheetProps, 'skills'>) {
  if (skills.length === 0) return <p className="text-ink-3">No skills yet</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {skills.map((skill) => (
        <li key={skill.name}>
          <Chip title={skill.privateTo && `Private skill of ${skill.privateTo}`}>
            {skill.privateTo && <Lock aria-label="Private" />}
            {skill.name}
            <Quiet>{skill.version}</Quiet>
          </Chip>
        </li>
      ))}
    </ul>
  );
}
