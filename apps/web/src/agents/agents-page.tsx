import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type ApiError, api, asApiError, fieldErrors, timeAgo } from '../api';
import { formatUsd, type RunStatus } from '../runs/run-data';
import { ApiErrorState } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, ErrorState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Input } from '../ui/input';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { Status, statusInCell, statusLabel } from '../ui/status';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { type Agent, type AgentSummary, type Template, useAgents } from './agents-data';
import { ImportAgentDialog } from './import-agent';

// [label, <col> width, cell classes]: narrow screens drop Owner first, then Role title, and a
// phone the two numbers.
const columns: [string, string, string][] = [
  ['Name', '', 'font-medium'],
  ['Role title', 'w-[26%] max-lg:hidden', 'text-ink-2 max-lg:hidden'],
  ['Owner', 'w-44 max-2xl:hidden', 'text-ink-2 max-2xl:hidden'],
  // The last 30 days, to compare agents; the agent's Quality section tells the rest.
  ['Accepted', 'w-32 max-md:hidden', 'tabular-nums max-md:hidden'],
  ['Cost per task', 'w-32 max-md:hidden', 'tabular-nums max-md:hidden'],
  ['Last run', 'w-80 max-xl:w-60 max-md:w-36', ''],
];

/** Queued, going or waiting for its owner: a run that is not over. */
const isLive = (status: RunStatus) =>
  status === 'queued' || status === 'running' || status === 'waiting_approval';

type View = 'active' | 'archived';

/** Agents: the person's agents, the archived ones a click away, New agent and Import. */
export function AgentsPage() {
  const [view, setView] = useState<View>('active');
  const [agents, setAgents] = useState<AgentSummary[]>();
  const [error, setError] = useState<ApiError>();

  const [attempt, setAttempt] = useState(0);
  // Only the answer for the view on screen counts: a slow one for the other tab is dropped.
  useEffect(() => {
    let current = true;
    setError(undefined);
    setAgents(undefined);
    const query = view === 'archived' ? '?archived=true' : '';
    api<{ agents: AgentSummary[] }>(`/api/agents${query}`).then(
      (data) => current && setAgents(data.agents),
      (caught: unknown) => current && setError(asApiError(caught)),
    );
    return () => {
      current = false;
    };
  }, [view, attempt]);

  const newAgent = <NewAgentDialog />;
  // With no agents at all, the empty state carries the one primary button; while the list
  // loads, the header waits to know which.
  const inHeader = view === 'archived' || Boolean(agents?.length);

  return (
    <>
      <PageHeader
        title="Agents"
        actions={
          <div className="flex gap-2">
            <ImportAgentDialog />
            {inHeader && newAgent}
          </div>
        }
      />
      <div className={cn(frame.wide, 'pt-4 pb-24')}>
        <Tabs value={view} onValueChange={(value) => setView(value as View)}>
          <TabsList aria-label="Agents to show">
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="archived">Archived</TabsTrigger>
          </TabsList>
          <TabsContent value={view} className="mt-4">
            {error ? (
              <ApiErrorState
                title="Couldn't load agents"
                error={error}
                onRetry={() => setAttempt((n) => n + 1)}
              />
            ) : !agents ? (
              <LoadingState label="Loading agents" />
            ) : agents.length > 0 ? (
              <AgentsTable agents={agents} />
            ) : view === 'active' ? (
              <EmptyState title="No agents yet" action={newAgent}>
                Create one from a role template.
              </EmptyState>
            ) : (
              <EmptyState title="No archived agents">
                Archived agents take no runs and keep their history; archive one from its sheet.
              </EmptyState>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function AgentsTable({ agents }: { agents: AgentSummary[] }) {
  return (
    <Table phoneList className="-mx-3 w-[calc(100%+24px)] table-fixed">
      <colgroup>
        {columns.map(([label, width]) => (
          <col key={label} className={width} />
        ))}
      </colgroup>
      <thead>
        <TableRow>
          {columns.map(([label, , className]) => (
            <TableHead key={label} className={className}>
              {label}
            </TableHead>
          ))}
        </TableRow>
      </thead>
      <tbody>
        {agents.map((agent) => (
          // The name is the link; its ::after covers the row, so the whole row opens the agent.
          <TableRow key={agent.id} className="relative hover:bg-hover">
            <TableCell primary className={columns[0]?.[2]}>
              <Link to={`/agents/${agent.id}`} className="after:absolute after:inset-0">
                {agent.name}
              </Link>
            </TableCell>
            <TableCell className={columns[1]?.[2]}>{agent.roleTitle}</TableCell>
            <TableCell className={columns[2]?.[2]}>{agent.owner.name}</TableCell>
            <TableCell className={columns[3]?.[2]}>
              {agent.month && agent.month.handed > 0 ? (
                <>
                  {Math.round((agent.month.accepted / agent.month.handed) * 100)}%
                  <span className="text-ink-3"> of {agent.month.handed}</span>
                </>
              ) : (
                <span className="text-ink-3">None</span>
              )}
            </TableCell>
            <TableCell className={columns[4]?.[2]}>
              {agent.month?.medianUsd ? (
                formatUsd(agent.month.medianUsd)
              ) : (
                <span className="text-ink-3">None</span>
              )}
            </TableCell>
            <TableCell>
              {agent.lastRun && isLive(agent.lastRun.status) && agent.lastRun.task ? (
                // At work: what on, which says more than that it works. Above the row's
                // own link, so it opens the run.
                <Status status={agent.lastRun.status} className={statusInCell}>
                  <span>
                    <Link to={`/runs/${agent.lastRun.id}`} className="relative z-1 hover:underline">
                      {agent.lastRun.task.title}
                    </Link>
                    {agent.lastRun.task.project && (
                      <span className="text-ink-3"> in {agent.lastRun.task.project}</span>
                    )}
                  </span>
                </Status>
              ) : agent.lastRun ? (
                <Status status={agent.lastRun.status} className={statusInCell}>
                  <span>
                    {statusLabel[agent.lastRun.status]}, {timeAgo(agent.lastRun.at)}
                  </span>
                </Status>
              ) : (
                <span className="text-ink-3">Never run</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
}

const blank = {
  id: 'blank',
  name: 'Blank agent',
  description: 'Starts empty: you write the instructions.',
  roleTitle: '',
};

/**
 * New agent and its dialog: picks a template or a blank agent, names it, and opens the new
 * agent in the editor. The button is the dialog's trigger, so Cancel hands focus back to it.
 */
function NewAgentDialog() {
  const navigate = useNavigate();
  const { reload } = useAgents();
  const ids = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | ApiError>();
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState(blank.id);
  const [name, setName] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  // A field the person typed in keeps their words when they pick another template.
  const [typed, setTyped] = useState({ name: false, roleTitle: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState(false);
  const options = [...(Array.isArray(templates) ? templates : []), blank];

  function choose(id: string, list = options) {
    const option = list.find((item) => item.id === id) ?? blank;
    setChoice(option.id);
    if (!typed.name) setName(option.id === blank.id ? '' : option.name);
    if (!typed.roleTitle) setRoleTitle(option.roleTitle);
  }

  useEffect(() => {
    if (!open) return;
    let current = true;
    setTemplates(undefined);
    setTyped({ name: false, roleTitle: false });
    setErrors({});
    setFailure(undefined);
    api<{ templates: Template[] }>('/api/templates').then(
      (data) => {
        if (!current) return;
        setTemplates(data.templates);
        const first = data.templates[0] ?? blank;
        setChoice(first.id);
        setName(first.id === blank.id ? '' : first.name);
        setRoleTitle(first.roleTitle);
      },
      (error: unknown) => current && setTemplates(asApiError(error)),
    );
    return () => {
      current = false;
    };
  }, [open, attempt]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setErrors({ name: 'Enter a name for the agent.' });
      nameInput.current?.focus();
      return;
    }
    setPending(true);
    setFailure(undefined);
    try {
      const templateId = choice === blank.id ? undefined : choice;
      const agent = await api<Agent>('/api/agents', { body: { name, roleTitle, templateId } });
      void reload();
      setOpen(false);
      navigate(`/agents/${agent.id}`);
    } catch (caught) {
      const error = asApiError(caught);
      const fields = fieldErrors(error);
      if (Object.keys(fields).length) setErrors(fields);
      else setFailure(error.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog open={open} onOpenChange={setOpen}>
      <D.DialogTrigger asChild>
        <Button variant="primary">New agent</Button>
      </D.DialogTrigger>
      <D.DialogContent>
        <form onSubmit={create} noValidate className="grid gap-4">
          <D.DialogTitle>New agent</D.DialogTitle>
          <D.DialogDescription>
            Start from a role template or from a blank agent. You can change everything later.
          </D.DialogDescription>
          {templates === undefined ? (
            <p role="status" className="py-6 text-ink-2">
              Loading templates…
            </p>
          ) : !Array.isArray(templates) ? (
            <ErrorState title="Couldn't load templates" onRetry={() => setAttempt((n) => n + 1)}>
              {templates.message}
            </ErrorState>
          ) : (
            <RadioGroup
              value={choice}
              onValueChange={choose}
              aria-label="Start from"
              className="-mx-2.5 grid max-h-[50vh] gap-px overflow-y-auto"
            >
              {options.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-3 rounded-md px-2.5 py-2 hover:bg-hover has-data-[state=checked]:bg-selected"
                >
                  <RadioGroupItem
                    value={option.id}
                    className="mt-0.5"
                    aria-labelledby={`${ids}-${option.id}`}
                    aria-describedby={`${ids}-${option.id}-text`}
                  />
                  <span>
                    <span id={`${ids}-${option.id}`} className="block font-medium">
                      {option.name}
                    </span>
                    <span id={`${ids}-${option.id}-text`} className="text-ink-2">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" error={errors.name}>
              {(control) => (
                <Input
                  {...control}
                  ref={nameInput}
                  value={name}
                  maxLength={100}
                  onChange={(event) => {
                    setName(event.target.value);
                    setTyped((was) => ({ ...was, name: true }));
                    setErrors({});
                  }}
                />
              )}
            </Field>
            <Field label="Role title" error={errors.roleTitle}>
              {(control) => (
                <Input
                  {...control}
                  value={roleTitle}
                  maxLength={200}
                  onChange={(event) => {
                    setRoleTitle(event.target.value);
                    setTyped((was) => ({ ...was, roleTitle: true }));
                  }}
                />
              )}
            </Field>
          </div>
          {failure && <FormError>{failure}</FormError>}
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button variant="quiet" type="button">
                Cancel
              </Button>
            </D.DialogClose>
            <Button variant="primary" type="submit" disabled={pending || !Array.isArray(templates)}>
              Create agent
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}
