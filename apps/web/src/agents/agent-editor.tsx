import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { isOnline } from '../admin/seats-data';
import { AgentSheet, type SheetAction } from '../agent-sheet/agent-sheet';
import { ApiError, api, asApiError, download, fieldErrors, formatDate, timeAgo } from '../api';
import { ApiErrorState, useMe } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, ErrorState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { fieldChip } from '../ui/chip';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Input, Textarea } from '../ui/input';
import { RadioGroup, RadioSegment, RadioTab } from '../ui/radio-group';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { AgentTeams } from '../teams/agent-teams';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { type Agent, codexModels, models, useAgents } from './agents-data';
import { MemorySection } from './memory-section';
import { QualitySection } from './quality-section';
import { SchedulesSection } from './schedules-section';
import { McpServersPicker } from './mcp-section';
import { SkillsSection } from './skills-section';
import { TransferDialog } from './transfer-dialog';
import { AgentTile, Tint } from '../ui/tint';
import { Laptop } from 'lucide-react';
import { useEnterprise } from '../admin/license-data';

// The markdown renderer is a fifth of the app's code and only Preview needs it: it loads then.
const Markdown = lazy(() =>
  import('../ui/markdown').then(({ Markdown }) => ({ default: Markdown })),
);

/** A model connection as every person sees it: a name and its models, never a key. */
type ServerConnection = {
  id: string;
  name: string;
  models: { id: string; engine: 'claude-code' | 'codex' }[];
};

// The draft holds every editable field as the text of its control; a change is a field whose
// text differs from the saved agent's.
const keys = [
  'name',
  'roleTitle',
  'instructions',
  'modelPref',
  'engine',
  'runsOn',
  'modelConnectionId',
  'serverShell',
  'maxMinutes',
  'maxTurns',
  'maxTokens',
  'usdPerMonth',
] as const;
type Key = (typeof keys)[number];
type Draft = Record<Key, string>;
const limitKeys = ['maxMinutes', 'maxTurns', 'maxTokens'] as const;
const budgetKeys = [...limitKeys, 'usdPerMonth'] as const;

const draftOf = (agent: Agent): Draft => ({
  name: agent.name,
  roleTitle: agent.roleTitle,
  instructions: agent.instructions,
  modelPref: agent.modelPref ?? '',
  engine: agent.engine,
  runsOn: agent.runsOn,
  modelConnectionId: agent.modelConnection?.id ?? '',
  serverShell: String(agent.serverShell),
  maxMinutes: String(agent.budget?.maxMinutes ?? ''),
  maxTurns: String(agent.budget?.maxTurns ?? ''),
  maxTokens: String(agent.budget?.maxTokens ?? ''),
  usdPerMonth: String(agent.budget?.usdPerMonth ?? ''),
});

// The sections in page order, with the fields each one edits: the nav marks unsaved ones.
const sections: [id: string, title: string, fields: readonly Key[]][] = [
  ['identity', 'Identity', ['name', 'roleTitle']],
  ['instructions', 'Instructions', ['instructions']],
  ['skills', 'Skills', []],
  ['team', 'Team', []],
  ['tools', 'Tools & policies', []],
  ['memory', 'Memory', []],
  ['schedules', 'Schedules', []],
  ['access', 'Access', []],
  ['budget', 'Budget', budgetKeys],
  [
    'engine',
    'Engine & model',
    ['engine', 'modelPref', 'runsOn', 'modelConnectionId', 'serverShell'],
  ],
  ['quality', 'Quality', []],
];
const sectionIds = sections.map(([id]) => id);

// A number as people type it: 2,000,000 and 2 000 000 are 2000000.
const digits = (value: string) => value.replace(/[\s,_]/g, '');
const number = (value: number) => value.toLocaleString('en-US');

/** What is wrong with the draft, by field, in the words of the field's error line. */
function problemsOf(draft: Draft): Partial<Record<Key, string>> {
  const found: Partial<Record<Key, string>> = {};
  if (!draft.name.trim()) found.name = 'Enter a name for the agent.';
  for (const key of limitKeys) {
    const value = digits(draft[key]);
    if (value && !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) < 2 ** 31)) {
      found[key] = 'Enter a whole number, or leave it empty.';
    }
  }
  const usd = digits(draft.usdPerMonth);
  if (usd && !(/^\d+(\.\d{1,2})?$/.test(usd) && Number(usd) > 0 && Number(usd) <= 1_000_000)) {
    found.usdPerMonth = 'Enter dollars, like 250 or 99.50, or leave it empty.';
  }
  return found;
}

/** The budget the draft describes; empty fields are not in it, no fields is no budget. */
function budgetOf(draft: Draft) {
  const set = budgetKeys.filter((key) => digits(draft[key]) !== '');
  return set.length
    ? Object.fromEntries(set.map((key) => [key, Number(digits(draft[key]))]))
    : null;
}

/** /agents/:id: one agent, its sections on the left and its live sheet on the right. */
export function AgentEditorPage() {
  const { id = '' } = useParams();
  // Another agent is another page: nothing of this one's draft carries over.
  return <AgentEditor key={id} id={id} />;
}

function AgentEditor({ id }: { id: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const sidebar = useAgents();
  const [agent, setAgent] = useState<Agent>();
  const [error, setError] = useState<ApiError>();
  const [draft, setDraft] = useState<Draft>();
  const [serverErrors, setServerErrors] = useState<Partial<Record<Key, string>>>({});
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [dialog, setDialog] = useState<'preview' | 'archive' | 'transfer'>();
  // What an agent may work with on the server: the admin's model connections, without keys.
  const [connections, setConnections] = useState<ServerConnection[]>([]);
  // Free has no agents on the server and no monthly budgets; the server says so too.
  const free = useEnterprise() === false;
  useEffect(() => {
    api<{ connections: ServerConnection[] }>('/api/models').then(
      (answer) => setConnections(answer.connections),
      () => setConnections([]),
    );
  }, []);
  // The memory section counts the documents for the sheet; the draft is not touched.
  const setMemoryCount = useCallback(
    (count: number) =>
      setAgent((was) =>
        was && was.memoryDocuments !== count ? { ...was, memoryDocuments: count } : was,
      ),
    [],
  );
  const opener = useRef<HTMLElement | null>(null);
  const [active, pickSection] = useActiveSection();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const loaded = await api<Agent>(`/api/agents/${id}`);
      setAgent(loaded);
      setDraft(draftOf(loaded));
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  const saved = agent && draftOf(agent);
  const changed = saved && draft ? keys.filter((key) => draft[key] !== saved[key]) : [];
  const guard = useLeaveGuard(changed.length > 0);
  const problems = draft ? problemsOf(draft) : {};

  async function save() {
    if (!agent || !draft || !saved || changed.length === 0 || saving) return;
    const invalid = keys.find((key) => problems[key]);
    if (invalid) {
      document.querySelector<HTMLElement>(`[data-field="${invalid}"]`)?.focus();
      return;
    }
    const sent = draft;
    const body: Record<string, unknown> = {};
    for (const key of ['name', 'roleTitle', 'instructions'] as const) {
      if (sent[key] !== saved[key]) body[key] = sent[key];
    }
    if (sent.modelPref !== saved.modelPref) body.modelPref = sent.modelPref || null;
    if (sent.engine !== saved.engine) body.engine = sent.engine;
    if (sent.runsOn !== saved.runsOn) body.runsOn = sent.runsOn;
    if (sent.modelConnectionId !== saved.modelConnectionId) {
      body.modelConnectionId = sent.modelConnectionId || null;
    }
    if (sent.serverShell !== saved.serverShell) body.serverShell = sent.serverShell === 'true';
    if (budgetKeys.some((key) => sent[key] !== saved[key])) body.budget = budgetOf(sent);
    setSaving(true);
    try {
      const next = await api<Agent>(`/api/agents/${agent.id}`, { method: 'PATCH', body });
      const after = draftOf(next);
      setAgent(next);
      // What was typed while the save was on its way stays a change; the rest is saved.
      setDraft(
        (current) =>
          current &&
          (Object.fromEntries(
            keys.map((key) => [key, current[key] === sent[key] ? after[key] : current[key]]),
          ) as Draft),
      );
      setServerErrors({});
      setJustSaved(true);
      if (next.name !== agent.name) void sidebar.reload();
    } catch (caught) {
      const failure = asApiError(caught);
      // An error the editor has a field for shows under it; any other is said in a toast.
      const byField = Object.entries(fieldErrors(failure)).filter(([key]) =>
        (keys as readonly string[]).includes(key),
      );
      if (byField.length) setServerErrors(Object.fromEntries(byField));
      else toast.error("Couldn't save changes", { description: failure.message });
    } finally {
      setSaving(false);
    }
  }
  // ⌘S and Ctrl S save, from any field.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function act(action: SheetAction) {
    if (!agent) return;
    // A run is a run of a task: Run opens New task for this agent.
    if (action === 'run') return navigate(`/tasks?agent=${agent.id}`, { state: { newTask: true } });
    if (action === 'preview' || action === 'archive' || action === 'transfer') {
      opener.current = document.activeElement as HTMLElement | null;
      return setDialog(action);
    }
    try {
      if (action === 'export') return await download(`/api/agents/${agent.id}/export`);
      const next = await api<Agent>(`/api/agents/${agent.id}/${action}`, { method: 'POST' });
      void sidebar.reload();
      if (action === 'duplicate') await navigate(`/agents/${next.id}`);
      else setAgent(next);
    } catch (caught) {
      toast.error(`Couldn't ${action} ${agent.name}`, { description: asApiError(caught).message });
    }
  }

  const header = (title: string, actions?: ReactNode) => (
    <PageHeader
      titleIn="bar"
      title={title}
      crumbs={[{ label: 'Agents', to: '/agents' }]}
      actions={actions}
    />
  );
  if (error?.code === 'not_found') {
    const all = (
      <Button asChild>
        <Link to="/agents">All agents</Link>
      </Button>
    );
    return (
      <>
        {header('Agent not found')}
        <EmptyState title="This agent doesn't exist or isn't shared with you" action={all}>
          Check the link, or pick an agent from the list.
        </EmptyState>
      </>
    );
  }
  if (error || !agent || !draft || !saved) {
    return (
      <>
        {header('Agent')}
        <div className={cn(frame.wide, 'pt-6')}>
          {error ? (
            <ApiErrorState title="Couldn't load the agent" error={error} onRetry={load} />
          ) : (
            <LoadingState label="Loading the agent" />
          )}
        </div>
      </>
    );
  }

  const edit = (key: Key, value: string) => {
    setDraft((current) => current && { ...current, [key]: value });
    setServerErrors((was) => ({ ...was, [key]: undefined }));
    setJustSaved(false);
  };
  // The sheet's dialogs have no trigger of their own: closing one hands focus back to the
  // sheet button that opened it.
  const refocus = (event: Event) => {
    event.preventDefault();
    opener.current?.focus();
  };
  const errorOf = (key: Key) => problems[key] ?? serverErrors[key];
  const archived = agent.status === 'archived';
  const count = changed.length;
  // A model saved through the API that the picker does not list stays choosable.
  const modelOptions =
    agent.modelPref && !models.some((model) => model.id === agent.modelPref)
      ? [...models, { id: agent.modelPref, name: agent.modelPref }]
      : models;
  const usd = problems.usdPerMonth ? agent.budget?.usdPerMonth : budgetOf(draft)?.usdPerMonth;
  const seat = agent.seat;

  return (
    <>
      {header(
        agent.name,
        <>
          {/* A save shows by the count going away; a screen reader hears it said. */}
          <span role="status" className={cn('mr-2 text-ink-2', count === 0 && 'sr-only')}>
            {count > 0
              ? `${count} unsaved ${count === 1 ? 'change' : 'changes'}`
              : justSaved && 'Changes saved'}
          </span>
          {count > 0 && (
            <>
              <Button
                variant="quiet"
                onClick={() => {
                  setDraft(saved);
                  setServerErrors({});
                }}
              >
                Discard
              </Button>
              <Button variant="primary" disabled={saving} onClick={() => void save()}>
                Save changes
              </Button>
            </>
          )}
        </>,
      )}
      <div
        className={cn(
          'grid gap-8 pt-6 pb-24 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[128px_minmax(0,1fr)_360px] 2xl:grid-cols-[136px_minmax(0,1fr)_380px]',
          frame.wide,
        )}
      >
        <nav aria-label="Sections" className="sticky top-[68px] hidden self-start xl:block">
          <ul className="grid gap-px">
            {sections.map(([section, title, fields]) => {
              const unsaved = fields.some((key) => changed.includes(key));
              return (
                <li key={section}>
                  <a
                    href={`#${section}`}
                    onClick={() => pickSection(section)}
                    aria-current={active === section ? 'true' : undefined}
                    className={cn(
                      'relative -ml-2 flex h-7.5 items-center rounded-md px-2 text-ink-2 hover:bg-hover hover:text-ink aria-[current]:font-medium aria-[current]:text-ink',
                      // The revision bar of the sheet, on the margin: this section has edits.
                      unsaved &&
                        'before:absolute before:inset-y-2 before:-left-1.5 before:w-0.5 before:rounded-full before:bg-ink-2',
                    )}
                  >
                    {title}
                    {unsaved && <span className="sr-only">, unsaved changes</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="max-w-160 min-w-0">
          {archived && (
            <p className="mb-6 text-ink-2">
              This agent is archived. It takes no runs until you unarchive it from its sheet.
            </p>
          )}
          {/* Who the agent is, as a page's title: its name and role are fields
              that read as the heading they are, saved with the rest. */}
          <section
            id="identity"
            aria-label="Identity"
            className="grid scroll-mt-20 gap-4.5 pb-9 md:scroll-mt-22"
          >
            <div className="flex items-start gap-3.5">
              <AgentTile
                id={agent.id}
                name={draft.name || agent.name}
                className="mt-0.5 size-11 rounded-xl text-[15px]"
              />
              <div className="grid min-w-0 flex-1">
                <input
                  aria-label="Name"
                  data-heading
                  data-field="name"
                  aria-invalid={errorOf('name') ? true : undefined}
                  aria-describedby={errorOf('name') ? 'name-error' : undefined}
                  value={draft.name}
                  maxLength={100}
                  placeholder="Name the agent"
                  onChange={(event) => edit('name', event.target.value)}
                  className={heading('text-name')}
                />
                <input
                  aria-label="Role title"
                  data-field="roleTitle"
                  aria-invalid={errorOf('roleTitle') ? true : undefined}
                  aria-describedby={errorOf('roleTitle') ? 'roleTitle-error' : undefined}
                  value={draft.roleTitle}
                  maxLength={200}
                  placeholder="The job, as people in the company would call it"
                  onChange={(event) => edit('roleTitle', event.target.value)}
                  className={heading('text-read text-ink-2')}
                />
                {(['name', 'roleTitle'] as const).map(
                  (key) =>
                    errorOf(key) && (
                      <p key={key} id={`${key}-error`} className="mt-1 text-small text-failed">
                        {errorOf(key)}
                      </p>
                    ),
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agent.projects.map((project) => (
                <Link key={project.id} to={`/projects/${project.id}`} className={fieldChip}>
                  <Tint id={project.id} kind="project" />
                  <span className="truncate">{project.name}</span>
                </Link>
              ))}
              {agent.projects.length === 0 && (
                <span className={cn(fieldChip, 'text-ink-3')}>
                  On no project, so it reaches no repository
                </span>
              )}
              {seat && (
                <span className={fieldChip}>
                  <Laptop aria-hidden="true" className="text-ink-2" />
                  <span className="truncate">
                    <span className="text-ink-3">Runs on</span> {seat.name}
                  </span>
                </span>
              )}
            </div>
          </section>

          <Section id="instructions" title="Instructions">
            <Instructions
              value={draft.instructions}
              error={errorOf('instructions')}
              onChange={(value) => edit('instructions', value)}
            />
          </Section>

          <Section id="skills" title="Skills">
            <SkillsSection
              agentId={agent.id}
              skills={agent.skills}
              onSaved={(skills) => setAgent((was) => was && { ...was, skills })}
            />
          </Section>

          <Section id="team" title="Team">
            <AgentTeams
              agentId={agent.id}
              agentName={agent.name}
              owned={agent.owner.id === me.id}
            />
          </Section>

          <Section id="tools" title="Tools & policies">
            <McpServersPicker
              agent={agent}
              onSaved={(next) =>
                setAgent((was) => was && { ...was, tools: next.tools, mcpServers: next.mcpServers })
              }
            />
            <PolicyMatrix
              agent={agent}
              onModeSaved={(tools) => setAgent((was) => was && { ...was, tools })}
              onSaved={(name, policy) =>
                setAgent(
                  (was) =>
                    was && {
                      ...was,
                      tools: was.tools.map((tool) =>
                        tool.name === name ? { ...tool, policy } : tool,
                      ),
                    },
                )
              }
            />
          </Section>

          <Section id="memory" title="Memory">
            <MemorySection agentId={agent.id} onCount={setMemoryCount} />
          </Section>

          <Section id="schedules" title="Schedules">
            <SchedulesSection agentId={agent.id} projects={agent.projects} />
          </Section>

          <Section id="access" title="Access">
            <ul className="grid gap-1.5">
              {agent.people.map((person) => (
                <li key={person.id} className="flex gap-3">
                  <span className="font-medium">{person.name}</span>
                  <span className="text-ink-2">
                    {person.validUntil
                      ? `Owner until ${formatDate(person.validUntil)}`
                      : person.validFrom
                        ? `Owner again from ${formatDate(person.validFrom)}`
                        : 'Owner'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-small text-ink-3">
              Only its owner can open and run this agent.
            </p>
          </Section>

          <Section id="budget" title="Budget">
            <div className="grid grid-cols-2 gap-4">
              {(
                [
                  ['maxMinutes', 'Minutes per run', number(agent.runDefaults.maxMinutes)],
                  ['maxTurns', 'Turns per run', number(agent.runDefaults.maxTurns)],
                  ['maxTokens', 'Tokens per run', number(agent.runDefaults.maxTokens)],
                  ['usdPerMonth', 'Monthly limit, USD', 'No limit'],
                ] as const
              ).map(([key, label, placeholder]) => (
                <Field key={key} label={label} error={errorOf(key)}>
                  {(control) => (
                    <Input
                      {...control}
                      data-field={key}
                      inputMode={key === 'usdPerMonth' ? 'decimal' : 'numeric'}
                      disabled={key === 'usdPerMonth' && free && draft.usdPerMonth === ''}
                      placeholder={placeholder}
                      value={draft[key]}
                      onChange={(event) => edit(key, event.target.value)}
                    />
                  )}
                </Field>
              ))}
            </div>
            <p className="mt-3 text-small text-ink-3">
              Empty fields use the platform default shown in them, and a run stops at the first
              limit it reaches. At the monthly limit no new run starts, and the owners hear of it at
              80%.{free && ' A monthly limit needs a license key.'}
            </p>
            {agent.spend.limit !== null && (
              <MonthlySpend
                agent={agent}
                onResumed={(next) => {
                  setAgent(next);
                }}
              />
            )}
          </Section>

          <Section id="engine" title="Engine & model">
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <span id="engine-label" className="font-medium">
                  Engine
                </span>
                <RadioGroup
                  aria-labelledby="engine-label"
                  value={draft.engine}
                  onValueChange={(value) => {
                    edit('engine', value);
                    // Each engine has models of its own.
                    edit('modelPref', '');
                  }}
                  className="grid w-full max-w-120 grid-cols-2 gap-2"
                >
                  <RadioTab value="claude-code">Claude Code</RadioTab>
                  <RadioTab value="codex">Codex</RadioTab>
                </RadioGroup>
                <span className="text-small text-ink-3">
                  {draft.engine === 'codex'
                    ? 'OpenAI’s Codex: under the owner’s ChatGPT sign-in, or by itself on a model connection’s GPT or company model. It leads no team.'
                    : 'Anthropic’s Claude Code: under the owner’s Claude subscription, or by itself on a model connection’s Claude model.'}
                </span>
              </div>
              <div className="grid gap-1.5">
                <span id="runs-on" className="font-medium">
                  Where it works
                </span>
                <RadioGroup
                  aria-labelledby="runs-on"
                  value={draft.runsOn}
                  onValueChange={(value) => {
                    edit('runsOn', value);
                    // An owner's computer's model is the subscription's; a server's comes from a connection.
                    edit('modelPref', '');
                  }}
                  className="grid w-full max-w-120 grid-cols-2 gap-2"
                >
                  <RadioTab value="laptop">With its owner</RadioTab>
                  <RadioTab
                    value="server"
                    disabled={(connections.length === 0 || free) && draft.runsOn !== 'server'}
                  >
                    By itself
                  </RadioTab>
                </RadioGroup>
                <span className="text-small text-ink-3">
                  {draft.runsOn === 'server'
                    ? 'On the company’s server, with a model connection’s key: nobody needs to be at work, and actions wait for a person where the tool policies say so.'
                    : `Under the owner’s ${draft.engine === 'codex' ? 'ChatGPT sign-in' : 'Claude subscription'}, while they are at work: in their place on the company’s server, or on their computer.${
                        free
                          ? ' Agents that work by themselves need a license key.'
                          : connections.length === 0
                            ? ' To work by itself it needs a model connection an admin adds in Admin → Models.'
                            : ''
                      }`}
                </span>
              </div>
              {draft.runsOn === 'server' ? (
                <>
                  <Field label="Model connection" error={errorOf('modelConnectionId')}>
                    {(control) => (
                      <Select
                        value={draft.modelConnectionId}
                        onValueChange={(value) => {
                          edit('modelConnectionId', value);
                          edit('modelPref', '');
                        }}
                      >
                        <SelectTrigger
                          {...control}
                          data-field="modelConnectionId"
                          className="w-80 max-w-full"
                        >
                          <SelectValue placeholder="Pick a connection" />
                        </SelectTrigger>
                        <SelectContent>
                          {connections.map((connection) => (
                            <SelectItem key={connection.id} value={connection.id}>
                              {connection.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                  <Field
                    label="Model"
                    hint={
                      draft.engine === 'codex'
                        ? 'Codex runs the models that are not Claude’s.'
                        : 'Claude Code runs Claude models only.'
                    }
                    error={errorOf('modelPref')}
                  >
                    {(control) => (
                      <Select
                        value={draft.modelPref}
                        onValueChange={(value) => edit('modelPref', value)}
                        disabled={!draft.modelConnectionId}
                      >
                        <SelectTrigger
                          {...control}
                          data-field="modelPref"
                          className="w-80 max-w-full"
                        >
                          <SelectValue placeholder="Pick a model" />
                        </SelectTrigger>
                        <SelectContent>
                          {(connections.find((c) => c.id === draft.modelConnectionId)?.models ?? [])
                            .filter((model) => model.engine === draft.engine)
                            .map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                <code>{model.id}</code>
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                  {me.role === 'admin' && (
                    <div className="flex max-w-120 items-start gap-3">
                      <Switch
                        id="server-shell"
                        aria-describedby="server-shell-note"
                        checked={draft.serverShell === 'true'}
                        onCheckedChange={(on) => edit('serverShell', String(on))}
                        className="mt-0.5"
                      />
                      <span className="grid gap-0.5">
                        <label htmlFor="server-shell" className="font-medium">
                          Allow a shell on the server
                        </label>
                        <span id="server-shell-note" className="text-small text-ink-3">
                          With a shell the agent could read the connection’s key. Allow it only to
                          an agent that has to run commands, such as tests.
                        </span>
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <Field
                    label="Model"
                    hint={`Default lets ${draft.engine === 'codex' ? 'Codex' : 'Claude Code'} choose on the computer that runs the task.`}
                    error={errorOf('modelPref')}
                  >
                    {(control) => (
                      <Select
                        value={draft.modelPref || 'default'}
                        onValueChange={(value) =>
                          edit('modelPref', value === 'default' ? '' : value)
                        }
                      >
                        <SelectTrigger
                          {...control}
                          data-field="modelPref"
                          className="w-80 max-w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default</SelectItem>
                          {(draft.engine === 'codex' ? codexModels : modelOptions).map((model) => (
                            <SelectItem
                              key={model.id}
                              value={model.id}
                              description={<code>{model.id}</code>}
                            >
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                </>
              )}
            </div>
          </Section>

          <Section id="quality" title="Quality">
            <QualitySection agentId={agent.id} />
          </Section>
        </div>

        <AgentSheet
          id={agent.id.slice(0, 8)}
          name={draft.name.trim() || 'Untitled agent'}
          roleTitle={draft.roleTitle}
          owner={agent.owner.name}
          since={formatDate(agent.createdAt)}
          template={agent.template}
          lastRun={
            agent.lastRun && { status: agent.lastRun.status, when: timeAgo(agent.lastRun.at) }
          }
          seat={
            // A server agent runs on the server seat, whatever its owner's computer is doing.
            draft.runsOn === 'server'
              ? {
                  name: `Server, ${
                    connections.find((c) => c.id === draft.modelConnectionId)?.name ??
                    'no model connection'
                  }`,
                  state: draft.modelConnectionId ? 'ready' : 'offline',
                }
              : seat && {
                  name: seat.name,
                  state: seat.busy
                    ? 'busy'
                    : isOnline({ status: 'active', lastSeenAt: seat.lastSeenAt })
                      ? 'ready'
                      : 'offline',
                }
          }
          projects={agent.projects.map((project) => ({
            name: project.name,
            host: project.hosts[0],
            repository: project.name,
          }))}
          connectors={[...new Set(agent.tools.map((tool) => tool.connector))].map((name) => ({
            name,
            tools: agent.tools
              .filter((tool) => tool.connector === name)
              .map((tool) => ({ action: tool.title, policy: tool.policy })),
          }))}
          people={agent.people.map(({ name, level, validFrom, validUntil }) => ({
            name,
            level,
            ...(validFrom && { from: formatDate(validFrom) }),
            ...(validUntil && { until: formatDate(validUntil) }),
          }))}
          budget={usd ?? null}
          spend={
            agent.spend.usdThisMonth > 0 ? { month: agent.spend.usdThisMonth, perTask: null } : null
          }
          skills={agent.skills}
          memoryDocuments={agent.memoryDocuments}
          unsavedChanges={count > 0}
          archived={archived}
          unavailable={{
            // What is not saved would stay behind with the person who no longer sees the agent.
            ...(count > 0 && { transfer: 'Save your changes before you transfer it.' }),
            ...(archived && { run: 'Unarchive the agent to run it.' }),
          }}
          onAction={(action) => void act(action)}
          className="self-start lg:sticky lg:top-[76px] lg:max-h-[calc(100dvh-100px)]"
        />
      </div>

      <PreviewDialog
        agent={agent}
        stale={count > 0}
        open={dialog === 'preview'}
        onClose={() => setDialog(undefined)}
        onCloseAutoFocus={refocus}
      />
      <ArchiveDialog
        agent={agent}
        open={dialog === 'archive'}
        onClose={() => setDialog(undefined)}
        onCloseAutoFocus={refocus}
        onArchived={(next) => {
          setAgent(next);
          void sidebar.reload();
        }}
      />
      <TransferDialog
        agent={agent}
        open={dialog === 'transfer'}
        onClose={() => setDialog(undefined)}
        onCloseAutoFocus={refocus}
        onTransferred={() => {
          // The agent is someone else's now: this page would answer "not found", and the list
          // without it is what says the transfer is done.
          void sidebar.reload();
          void navigate('/agents');
        }}
      />
      <D.Dialog open={guard.asking} onOpenChange={(open) => !open && guard.stay()}>
        <D.DialogContent onCloseAutoFocus={guard.refocus}>
          <D.DialogTitle>Leave without saving?</D.DialogTitle>
          <D.DialogDescription>
            {count} unsaved {count === 1 ? 'change' : 'changes'} to {agent.name} will be lost.
          </D.DialogDescription>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button variant="quiet">Keep editing</Button>
            </D.DialogClose>
            <Button variant="danger" onClick={guard.leave}>
              Leave without saving
            </Button>
          </D.DialogFooter>
        </D.DialogContent>
      </D.Dialog>
    </>
  );
}

/** A field that reads as the heading it is: no frame until hovered or focused. */
const heading = (size: string) =>
  cn(
    '-mx-1.5 min-w-0 rounded-md border border-transparent bg-transparent px-1.5 outline-none placeholder:text-ink-3 hover:bg-hover focus-visible:border-line-control focus-visible:bg-raised aria-invalid:border-failed',
    size,
  );

function Section(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={props.id}
      aria-labelledby={`${props.id}-title`}
      className="scroll-mt-20 pb-9 md:scroll-mt-22"
    >
      {/* Ruled off under its name, as Linear's lists are. */}
      <h2 id={`${props.id}-title`} className="mb-4 border-b border-line pb-2 text-section">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

/**
 * What the instructions read like, and their markdown source in mono. An agent that has
 * instructions opens on the first, which is what people come to read; one that has none opens
 * on the second, where they are written.
 */
function Instructions(props: { value: string; error?: string; onChange: (value: string) => void }) {
  const [view, setView] = useState(() => (props.value.trim() ? 'preview' : 'write'));
  // The field and what is wrong with it are on Write.
  useEffect(() => {
    if (props.error) setView('write');
  }, [props.error]);
  return (
    <Tabs value={view} onValueChange={setView}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <TabsList aria-label="Instructions view">
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        <span className="text-small text-ink-3">Markdown. Goes into CLAUDE.md as it is.</span>
      </div>
      <TabsContent value="write">
        <Textarea
          aria-labelledby="instructions-title"
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? 'instructions-error' : undefined}
          data-field="instructions"
          rows={18}
          value={props.value}
          placeholder="What this agent does, how it works, and when a task is done."
          onChange={(event) => props.onChange(event.target.value)}
          className="font-mono text-small leading-5"
        />
        {props.error && (
          <p id="instructions-error" className="mt-1.5 text-small text-failed">
            {props.error}
          </p>
        )}
      </TabsContent>
      <TabsContent value="preview" className="min-h-93 rounded-md border border-line px-3 py-2">
        {props.value.trim() ? (
          <Suspense>
            <Markdown>{props.value}</Markdown>
          </Suspense>
        ) : (
          <p className="text-ink-3">Nothing to preview yet. Write the instructions first.</p>
        )}
      </TabsContent>
    </Tabs>
  );
}

type Policy = Agent['tools'][number]['policy'];

/**
 * Who decides each tool. The workspace tools stay allowed: the CLI runs them alone, with
 * nobody to ask. The code host tools go through the gateway, which follows these, and a
 * change saves at once: it applies to the next call, not to a draft.
 */
function PolicyMatrix(props: {
  agent: Agent;
  onSaved: (name: string, policy: Policy) => void;
  onModeSaved: (tools: Agent['tools']) => void;
}) {
  const { agent, onSaved } = props;
  const [picked, setPicked] = useState<Record<string, Policy>>({});
  // The latest choice of each tool, and its saves one after another: two requests in flight
  // could reach the server in either order and leave it the older choice.
  const latest = useRef<Record<string, number>>({});
  const queue = useRef<Record<string, Promise<void>>>({});
  const [error, setError] = useState<string>();
  // Auto or manual, as the tools stand now: what Workspace and the team's step do is not the
  // owner's switch, and a tool denied stays denied either way.
  const switched = agent.tools.filter(
    (tool) =>
      tool.connector !== 'Workspace' &&
      tool.name !== 'team_step' &&
      (picked[tool.name] ?? tool.policy) !== 'deny',
  );
  const mode = switched.every((tool) => (picked[tool.name] ?? tool.policy) === 'allow')
    ? 'auto'
    : switched.every((tool) => (picked[tool.name] ?? tool.policy) === 'ask')
      ? 'manual'
      : 'mixed';
  const [switching, setSwitching] = useState(false);
  async function switchTo(policy: 'allow' | 'ask') {
    if (switching) return;
    setSwitching(true);
    setError(undefined);
    try {
      const next = await api<Agent>(`/api/agents/${agent.id}/tools`, {
        method: 'PUT',
        body: { policy },
      });
      setPicked({});
      props.onModeSaved(next.tools);
    } catch (caught) {
      setError(`Couldn't switch the tools. ${asApiError(caught).message}`);
    } finally {
      setSwitching(false);
    }
  }
  const grid = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4';
  const connectors = [...new Set(agent.tools.map((tool) => tool.connector))];

  async function choose(name: string, policy: Policy) {
    const ticket = (latest.current[name] ?? 0) + 1;
    latest.current[name] = ticket;
    setPicked((was) => ({ ...was, [name]: policy }));
    setError(undefined);
    const turn = (queue.current[name] ?? Promise.resolve()).then(() => save(name, policy, ticket));
    queue.current[name] = turn;
    await turn;
  }

  async function save(name: string, policy: Policy, ticket: number) {
    // A newer choice waits behind this one and sends itself: this one is already stale.
    if (ticket !== latest.current[name]) return;
    let saved: Policy | undefined;
    try {
      const next = await api<Agent>(`/api/agents/${agent.id}/tools/${name}`, {
        method: 'PUT',
        body: { policy },
      });
      saved = next.tools.find((tool) => tool.name === name)?.policy;
    } catch (caught) {
      if (ticket === latest.current[name]) {
        setError(`Couldn't change ${name}. ${asApiError(caught).message}`);
      }
    }
    if (ticket !== latest.current[name]) return;
    // Only this tool's policy: the answer carries the whole agent, which the page's other
    // state (an unsaved draft, another tool's change in flight) must not be replaced by.
    if (saved) onSaved(name, saved);
    setPicked((was) => Object.fromEntries(Object.entries(was).filter(([key]) => key !== name)));
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div
          role="group"
          aria-label="Approvals"
          className="inline-flex rounded-md border border-line p-0.5"
        >
          {(['auto', 'manual'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={switching || switched.length === 0}
              onClick={() => void switchTo(value === 'auto' ? 'allow' : 'ask')}
              className="h-7 rounded-[5px] px-3 text-ui text-ink-2 hover:text-ink aria-pressed:bg-hover aria-pressed:font-medium aria-pressed:text-ink"
            >
              {value === 'auto' ? 'Auto' : 'Manual'}
            </button>
          ))}
        </div>
        <p className="text-small text-ink-3">
          {mode === 'auto'
            ? 'Every tool runs without asking, except the ones you deny.'
            : mode === 'manual'
              ? 'Every tool asks you first, except the ones you deny.'
              : 'Some tools ask you first, some run without asking. Auto or Manual sets them all.'}
        </p>
      </div>
      {connectors.map((connector) => {
        const fixed = connector === 'Workspace';
        return (
          <div key={connector} role="group" aria-label={connector}>
            <p className="pt-3 pb-1 text-small text-ink-3">
              {fixed
                ? 'Workspace, always allowed'
                : agent.mcpServers.some((server) => server.name === connector)
                  ? `${connector}, MCP server`
                  : connector}
            </p>
            {agent.tools
              .filter((tool) => tool.connector === connector)
              .map((tool) => (
                <RadioGroup
                  key={tool.name}
                  value={picked[tool.name] ?? tool.policy}
                  disabled={fixed}
                  onValueChange={(value) => void choose(tool.name, value as Policy)}
                  aria-label={tool.title}
                  className={cn(grid, 'min-h-12 border-b border-line py-1.5')}
                >
                  {/* What the tool does first; its identifier for whoever reads the logs. */}
                  <span className="min-w-0 justify-self-start">
                    <span className="block">{tool.title}</span>
                    <code className="text-small break-all text-ink-3">{tool.name}</code>
                  </span>
                  <span className="inline-flex rounded-md border border-line-strong p-0.5">
                    <RadioSegment value="allow" aria-label="Allow">
                      Allow
                    </RadioSegment>
                    <RadioSegment value="ask" tone="ask" aria-label="Ask owner">
                      Ask
                    </RadioSegment>
                    <RadioSegment value="deny" aria-label="Deny">
                      Deny
                    </RadioSegment>
                  </span>
                </RadioGroup>
              ))}
          </div>
        );
      })}
      {error && (
        <div className="mt-3">
          <FormError>{error}</FormError>
        </div>
      )}
      <p className="mt-3 text-small text-ink-3">
        Policies save as you change them. Ask owner holds the call in Approvals until you approve or
        deny it.
      </p>
    </div>
  );
}

type Profile = { claudeMd: string; settings: unknown };

/** What a run of the agent gets: CLAUDE.md and the settings, as saved. */
function PreviewDialog(props: {
  agent: Agent;
  stale: boolean;
  open: boolean;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [profile, setProfile] = useState<Profile | ApiError>();
  const [attempt, setAttempt] = useState(0);
  const [file, setFile] = useState('claudeMd');
  const [copied, setCopied] = useState(false);
  const shown = useRef<HTMLPreElement>(null);
  const id = props.agent.id;
  useEffect(() => {
    if (!props.open) return;
    let current = true;
    setProfile(undefined);
    api<Profile>(`/api/agents/${id}/workspace-preview`).then(
      (loaded) => current && setProfile(loaded),
      (error: unknown) => current && setProfile(asApiError(error)),
    );
    return () => {
      current = false;
    };
  }, [props.open, id, attempt]);

  const text =
    profile && !(profile instanceof ApiError)
      ? file === 'claudeMd'
        ? profile.claudeMd
        : JSON.stringify(profile.settings, null, 2)
      : '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Without clipboard access (plain http), select the text for ⌘C instead.
      if (shown.current) window.getSelection()?.selectAllChildren(shown.current);
    }
  }

  return (
    <D.Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent size="wide" onCloseAutoFocus={props.onCloseAutoFocus}>
        <D.DialogTitle>Preview workspace</D.DialogTitle>
        <D.DialogDescription>
          What each run of {props.agent.name} gets.
          {props.stale && ' This is the saved version: save your changes to see them here.'}
        </D.DialogDescription>
        {profile === undefined ? (
          <p role="status" className="py-6 text-ink-2">
            Loading the workspace…
          </p>
        ) : profile instanceof ApiError ? (
          <ErrorState title="Couldn't load the workspace" onRetry={() => setAttempt((n) => n + 1)}>
            {profile.message}
          </ErrorState>
        ) : (
          <Tabs
            value={file}
            onValueChange={(value) => {
              setFile(value);
              setCopied(false);
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <TabsList aria-label="File">
                <TabsTrigger value="claudeMd">CLAUDE.md</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <Button size="sm" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <TabsContent value={file}>
              <pre
                ref={shown}
                className="max-h-[55vh] overflow-y-auto rounded-lg bg-desk p-3 font-mono text-small whitespace-pre-wrap"
              >
                {text}
              </pre>
            </TabsContent>
          </Tabs>
        )}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="primary">Done</Button>
          </D.DialogClose>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}

function ArchiveDialog(props: {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
  onArchived: (agent: Agent) => void;
}) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function archive() {
    setPending(true);
    setError(undefined);
    try {
      props.onArchived(
        await api<Agent>(`/api/agents/${props.agent.id}/archive`, { method: 'POST' }),
      );
      props.onClose();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <D.Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        <D.DialogTitle>Archive {props.agent.name}?</D.DialogTitle>
        <D.DialogDescription>
          It takes no more runs, its queued runs are cancelled, and it leaves the sidebar. Its
          history stays, and you can unarchive it at any time.
        </D.DialogDescription>
        {error && <FormError>{error}</FormError>}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="quiet">Cancel</Button>
          </D.DialogClose>
          <Button variant="danger" disabled={pending} onClick={() => void archive()}>
            Archive
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}

/**
 * Asks before unsaved edits are left behind: any move to another page of the app, Back and
 * Forward included, waits for the person's answer, and the browser asks before the tab
 * closes or reloads. A move to sign-in is not held: the session has ended by then.
 */
function useLeaveGuard(dirty: boolean) {
  // The link or button that asked to leave, for focus to go back to if the person stays.
  const from = useRef<HTMLElement | null>(null);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const leaving =
      dirty &&
      nextLocation.pathname !== currentLocation.pathname &&
      nextLocation.pathname !== '/login';
    if (leaving) from.current = document.activeElement as HTMLElement | null;
    return leaving;
  });
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  return {
    asking: blocker.state === 'blocked',
    stay: () => blocker.reset?.(),
    leave: () => blocker.proceed?.(),
    refocus: (event: Event) => {
      event.preventDefault();
      from.current?.focus();
    },
  };
}

/** The section under the page header, for aria-current in the section nav. */
function useActiveSection() {
  const [active, setActive] = useState(sectionIds[0]);
  // A section picked in the nav stays current until the person scrolls: the last sections are
  // too short to reach the top, so the jump alone would light up the wrong one.
  const picked = useRef(false);
  useEffect(() => {
    const update = () => {
      if (picked.current) return;
      let current = sectionIds[0];
      for (const id of sectionIds) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= 120) current = id;
      }
      // Scrolled to the bottom by hand, the last section is current.
      const bottom =
        window.scrollY > 0 &&
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setActive(bottom ? sectionIds.at(-1) : current);
    };
    const release = () => (picked.current = false);
    const events = ['wheel', 'touchmove', 'keydown'] as const;
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    for (const event of events) window.addEventListener(event, release, { passive: true });
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      for (const event of events) window.removeEventListener(event, release);
    };
  }, []);
  const pick = (id: string) => {
    picked.current = true;
    setActive(id);
  };
  return [active, pick] as const;
}

/**
 * This month's spend against the limit; once it is reached, new runs are refused until the
 * owner lets the agent go on for the rest of the month, or raises the limit above.
 */
function MonthlySpend(props: { agent: Agent; onResumed: (agent: Agent) => void }) {
  const { spend } = props.agent;
  const [pending, setPending] = useState(false);
  const money = (usd: number) =>
    usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  async function resume() {
    setPending(true);
    try {
      props.onResumed(
        await api<Agent>(`/api/agents/${props.agent.id}/budget/resume`, { method: 'POST' }),
      );
    } catch (caught) {
      toast.error("Couldn't let the agent go on", { description: asApiError(caught).message });
    } finally {
      setPending(false);
    }
  }
  const blocked = spend.reached && !spend.resumed;
  return (
    <div
      role="status"
      aria-label="Spend this month"
      className={cn(
        'mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3',
        blocked ? 'border-failed/40' : 'border-line',
      )}
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium">
          {money(spend.usdThisMonth)} of {money(spend.limit ?? 0)}
        </span>{' '}
        <span className="text-ink-2">
          {blocked
            ? 'this month: the limit is reached, and new runs are refused.'
            : spend.resumed
              ? 'this month, and its owner let it go on past the limit until the month ends.'
              : 'spent this month.'}
        </span>
      </p>
      {blocked && (
        <Button disabled={pending} onClick={() => void resume()}>
          Continue this month
        </Button>
      )}
    </div>
  );
}
