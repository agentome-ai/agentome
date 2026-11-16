import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { type ApiError, api, asApiError, fieldErrors } from '../api';
import { useAgents } from '../agents/agents-data';
import { ApiErrorState, useMe } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, ErrorState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Combobox } from '../ui/combobox';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Input } from '../ui/input';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { agentLabel, modeLabel, type TeamSummary, type TeamTemplate } from './teams-data';
import { Tint } from '../ui/tint';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { OrgChart } from './org-chart';

// [label, <col> width, cell classes]: narrow screens drop the order first, a phone the members.
const columns: [string, string, string][] = [
  ['Team', '', 'font-medium'],
  ['Lead', 'w-56 max-md:w-36', 'text-ink-2'],
  ['Members', 'w-80 max-md:hidden', 'text-ink-2 max-md:hidden'],
  ['Order', 'w-40 max-lg:hidden', 'text-ink-2 max-lg:hidden'],
];

/**
 * The teams as their chart: a team whose lead is a member of another team sits under
 * it, so the company reads from the top lead down. The server keeps the chart free of circles.
 */
function chartOf(teams: TeamSummary[]) {
  const above = new Map<string, TeamSummary>();
  for (const team of teams) {
    const parent = teams.find((other) => other.members.some((m) => m.id === team.lead.id));
    if (parent) above.set(team.id, parent);
  }
  const rows: { team: TeamSummary; depth: number; under?: TeamSummary }[] = [];
  const visit = (team: TeamSummary, depth: number) => {
    if (rows.some((row) => row.team.id === team.id)) return;
    rows.push({ team, depth, under: above.get(team.id) });
    for (const child of teams.filter((other) => above.get(other.id)?.id === team.id)) {
      visit(child, depth + 1);
    }
  };
  for (const team of teams.filter((one) => !above.has(one.id))) visit(team, 0);
  // A team only a circle reaches, which the server refuses, still shows.
  for (const team of teams) visit(team, 0);
  return rows;
}

/** Teams: agents that work together in their lead's runs, put together and copied whole. */
export function TeamsPage() {
  const [teams, setTeams] = useState<TeamSummary[]>();
  const [error, setError] = useState<ApiError>();
  const load = useCallback(async () => {
    setError(undefined);
    try {
      setTeams((await api<{ teams: TeamSummary[] }>('/api/teams')).teams);
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, []);
  useEffect(() => void load(), [load]);
  // The chart by default; the list for the teams' order and mode.
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'list' ? 'list' : 'chart';

  const newTeam = <NewTeamDialog />;
  return (
    <>
      <PageHeader title="Teams" actions={teams?.length ? newTeam : undefined} />
      <div className={cn(frame.wide, 'pt-4 pb-24')}>
        {error ? (
          <ApiErrorState title="Couldn't load teams" error={error} onRetry={load} />
        ) : !teams ? (
          <LoadingState label="Loading teams" />
        ) : teams.length === 0 ? (
          <EmptyState title="No teams yet" action={newTeam}>
            A team works in its lead's runs: the lead splits a task between its members, and they
            work at the same time. Put a lead of another team in it, and the lead assigns that team
            whole tasks. Create one, then add agents to it.
          </EmptyState>
        ) : (
          <Tabs
            value={view}
            onValueChange={(next) => setParams(next === 'list' ? { view: 'list' } : {})}
            className="grid gap-4"
          >
            <TabsList aria-label="View">
              <TabsTrigger value="chart">Chart</TabsTrigger>
              <TabsTrigger value="list">List</TabsTrigger>
            </TabsList>
            {view === 'chart' ? (
              <OrgChart teams={teams} onChanged={load} />
            ) : (
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
                  {chartOf(teams).map(({ team, depth, under }) => (
                    <TableRow key={team.id} className="relative hover:bg-hover">
                      <TableCell primary className={columns[0]?.[2]}>
                        <Link
                          to={`/teams/${team.id}`}
                          className="flex min-w-0 items-center gap-2 after:absolute after:inset-0"
                          style={{ paddingLeft: `${depth * 1.25}rem` }}
                        >
                          <Tint id={team.id} kind="team" />
                          <span className="truncate">{team.name}</span>
                          {under && <span className="sr-only">, under {under.name}</span>}
                        </Link>
                      </TableCell>
                      <TableCell className={columns[1]?.[2]}>{team.lead.name}</TableCell>
                      <TableCell className={columns[2]?.[2]}>
                        {team.members.length
                          ? team.members.map((member) => member.name).join(', ')
                          : 'No members yet'}
                      </TableCell>
                      <TableCell className={columns[3]?.[2]}>{modeLabel[team.mode]}</TableCell>
                    </TableRow>
                  ))}
                </tbody>
              </Table>
            )}
          </Tabs>
        )}
      </div>
    </>
  );
}

/** The choice that starts a team from the person's own agents rather than a template. */
const OWN = '';

/**
 * New team: from a team template, which creates its agents too, or from the person's own
 * agents: a name and its lead now, members on the page it opens. From an agent's page, the
 * agent is the lead and no template is offered.
 */
export function NewTeamDialog(props: { leadId?: string; trigger?: React.ReactNode }) {
  const me = useMe();
  const navigate = useNavigate();
  const ids = useId();
  const { agents, reload } = useAgents();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TeamTemplate[] | ApiError>();
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState(OWN);
  const [name, setName] = useState('');
  const [typed, setTyped] = useState(false);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const leads = agents
    .filter((agent) => agent.status === 'active' && agent.owner.id === me.id)
    .map((agent) => ({
      value: agent.id,
      label: agentLabel(agent),
    }));
  const offerTemplates = !props.leadId;
  const template = Array.isArray(templates)
    ? templates.find((item) => item.name === choice)
    : undefined;

  useEffect(() => {
    if (!open || !offerTemplates) return;
    let current = true;
    setTemplates(undefined);
    api<{ templates: TeamTemplate[] }>('/api/teams/templates').then(
      (data) => {
        if (!current) return;
        setTemplates(data.templates);
        // Someone without agents yet starts from the template; someone with them, from theirs.
        const first = data.templates[0];
        if (first && leads.length === 0) choose(first.name);
      },
      (caught: unknown) => current && setTemplates(asApiError(caught)),
    );
    return () => {
      current = false;
    };
    // Loaded once per opening: a change in the agents list does not reload it.
  }, [open, attempt, offerTemplates]);

  function choose(next: string) {
    setChoice(next);
    setError(undefined);
    if (!typed) setName(next === OWN ? '' : next);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!template && !leadId) return;
    setPending(true);
    setError(undefined);
    try {
      const team = template
        ? await api<TeamSummary>('/api/teams/from-template', {
            method: 'POST',
            body: { template: template.name, name },
          })
        : await api<TeamSummary>('/api/teams', { method: 'POST', body: { name, leadId } });
      if (template) void reload();
      setOpen(false);
      await navigate(`/teams/${team.id}`);
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  const options = [
    ...(Array.isArray(templates) ? templates : []).map((item) => {
      const roles = [item.lead, ...item.members];
      return {
        name: item.name,
        title: item.name,
        text: item.description,
        detail: `Creates ${roles.length} agents: ${roles.join(', ')}.`,
      };
    }),
    {
      name: OWN,
      title: 'Your agents',
      text: "Pick one of your agents to lead, then add members on the team's page.",
      detail: '',
    },
  ];

  return (
    <D.Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          const lead = agents.find((agent) => agent.id === props.leadId);
          setName(lead ? `${lead.name} team` : '');
          setTyped(false);
          setChoice(OWN);
          setLeadId(props.leadId ?? null);
          setError(undefined);
        }
      }}
    >
      <D.DialogTrigger asChild>
        {props.trigger ?? <Button size="sm">New team</Button>}
      </D.DialogTrigger>
      <D.DialogContent>
        <form onSubmit={(event) => void create(event)} noValidate>
          <D.DialogTitle>New team</D.DialogTitle>
          <D.DialogDescription>
            The lead takes the team's tasks and splits them between its members. An agent leads one
            team at most.
          </D.DialogDescription>
          <div className="grid gap-4 py-4">
            {offerTemplates &&
              (templates === undefined ? (
                <p role="status" className="py-2 text-ink-2">
                  Loading templates…
                </p>
              ) : !Array.isArray(templates) ? (
                <ErrorState
                  title="Couldn't load team templates"
                  onRetry={() => setAttempt((n) => n + 1)}
                >
                  {templates.message}
                </ErrorState>
              ) : (
                <RadioGroup
                  value={choice}
                  onValueChange={choose}
                  aria-label="Start from"
                  className="-mx-2.5 grid gap-px"
                >
                  {options.map((option, index) => (
                    <label
                      key={option.name}
                      className="flex cursor-pointer items-start gap-3 rounded-md px-2.5 py-2 hover:bg-hover has-data-[state=checked]:bg-selected"
                    >
                      <RadioGroupItem
                        value={option.name}
                        className="mt-0.5"
                        aria-labelledby={`${ids}-${index}`}
                        aria-describedby={`${ids}-${index}-text`}
                      />
                      <span>
                        <span id={`${ids}-${index}`} className="block font-medium">
                          {option.title}
                        </span>
                        <span id={`${ids}-${index}-text`} className="text-ink-2">
                          {option.text}
                          {option.detail && <span className="mt-1 block">{option.detail}</span>}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              ))}
            <Field label="Name" error={error && fieldErrors(error).name}>
              {(control) => (
                <Input
                  {...control}
                  autoFocus={!offerTemplates}
                  value={name}
                  maxLength={100}
                  onChange={(event) => {
                    setName(event.target.value);
                    setTyped(true);
                  }}
                />
              )}
            </Field>
            {!template && (
              <Field label="Lead" hint="One of your agents. Its runs are where the team works.">
                {(control) => (
                  <Combobox
                    id={control.id}
                    value={leadId}
                    options={leads}
                    placeholder="Pick an agent"
                    searchPlaceholder="Search agents"
                    emptyText="You have no active agent yet"
                    onValueChange={setLeadId}
                  />
                )}
              </Field>
            )}
            {error && !fieldErrors(error).name && <FormError>{error.message}</FormError>}
          </div>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </D.DialogClose>
            <Button
              type="submit"
              disabled={pending || name.trim() === '' || (!template && !leadId)}
            >
              Create team
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}
