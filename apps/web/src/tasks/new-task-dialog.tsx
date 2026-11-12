import { Folder, Laptop, UserRound, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { sidebarSeat, useSeats } from '../admin/seats-data';
import { type AgentSummary, type Agent, useAgents } from '../agents/agents-data';
import { type ApiError, api, asApiError, fieldErrors } from '../api';
import type { ProjectSummary, ProjectView } from '../projects/projects-data';
import { ErrorState } from '../shell/states';
import { Button } from '../ui/button';
import { fieldChip } from '../ui/chip';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import { FormError } from '../ui/field';
import { Select, SelectChip, SelectContent, SelectGroup, SelectItem } from '../ui/select';
import { Switch } from '../ui/switch';
import type { TeamSummary } from '../teams/teams-data';
import { AgentTile, Tint } from '../ui/tint';
import { RepositoryPicker, Where } from './repository-picker';
import { repositoryProblem, type Task } from './tasks-data';

type Key = 'projectId' | 'agentId' | 'title' | 'body' | 'repository';
const order: Key[] = ['projectId', 'agentId', 'title', 'body', 'repository'];

/**
 * New task and its dialog, as Linear's composer: the title and the description as
 * plain text, its project, who does it and where as chips under them, Run now and Create at the
 * foot. Every task is filed in a project, so the work stays with the company's. The
 * button is the dialog's trigger, so closing hands focus back to it; the page owns `open`, so
 * that Run on an agent's sheet can arrive with the dialog open. `agentId` is the agent to choose;
 * `project` files the task in a project, whose page opens it, and starts it as the project does.
 */
export function NewTaskDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId?: string;
  project?: { id: string; intake: 'auto' | 'manual' };
  trigger?: ReactNode;
}) {
  // While the task is on its way the dialog stays open: it then shows where the task went.
  const [pending, setPending] = useState(false);
  return (
    <D.Dialog open={props.open} onOpenChange={(open) => pending || props.onOpenChange(open)}>
      <D.DialogTrigger asChild>
        {props.trigger ?? <Button variant="primary">New task</Button>}
      </D.DialogTrigger>
      <D.DialogContent
        size="wide"
        className={D.composer}
        // The agent is chosen for the person, so typing starts in Title.
        onOpenAutoFocus={(event) => {
          const title = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
            '[data-field="title"]',
          );
          if (!title) return;
          event.preventDefault();
          title.focus();
        }}
      >
        {/* Mounted only while open: every opening starts a new task. */}
        <NewTaskForm
          agentId={props.agentId}
          project={props.project}
          pending={pending}
          setPending={setPending}
          onCreated={() => props.onOpenChange(false)}
        />
      </D.DialogContent>
    </D.Dialog>
  );
}

function NewTaskForm(props: {
  agentId?: string;
  project?: { id: string; intake: 'auto' | 'manual' };
  pending: boolean;
  setPending: (pending: boolean) => void;
  onCreated: () => void;
}) {
  const navigate = useNavigate();
  const sidebar = useAgents();
  const seat = sidebarSeat(useSeats().seats);
  const ids = useId();
  const form = useRef<HTMLFormElement>(null);
  const [agents, setAgents] = useState<AgentSummary[] | ApiError>();
  const [attempt, setAttempt] = useState(0);
  // Who takes it, as `agent:<id>` or `team:<id>`: a team's task goes to its lead, who splits it
  // between the members.
  const [target, setTarget] = useState('');
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  // The project it is filed in: the task shows on its page, goes to its agents and works in its
  // repository.
  const [projects, setProjects] = useState<ProjectSummary[] | ApiError>();
  const [projectId, setProjectId] = useState(props.project?.id ?? '');
  // The projects of the agent the dialog opened for: the first one is chosen for the person.
  const [wantedOn, setWantedOn] = useState<string[]>();
  const [project, setProject] = useState<ProjectView>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [repository, setRepository] = useState('');
  // A project whose lead takes its tasks runs them; one that waits for a person, waits.
  const [runNow, setRunNow] = useState(props.project ? props.project.intake === 'auto' : true);
  // The repositories of the chosen agent's projects, each project's main one first. The field
  // starts at the first of them and follows the agent, unless the person typed their own.
  const [known, setKnown] = useState<string[]>([]);
  const offered = useRef<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [failure, setFailure] = useState<string>();

  // The person's active agents, fresh: an archived agent takes no tasks and is not offered.
  // The agent the dialog opened for is chosen, and none if it is not among them, rather than
  // another one the person did not pick.
  const { agentId: wanted } = props;
  // A project's task goes to its team, chosen once the project is read: no agent before it.
  const filed = Boolean(props.project);
  useEffect(() => {
    let current = true;
    setAgents(undefined);
    api<{ agents: AgentSummary[] }>('/api/agents').then(
      ({ agents: list }) => {
        if (!current) return;
        setAgents(list);
        // Any other agent comes with the project: only its agents take its tasks.
        const first = wanted ? list.find((agent) => agent.id === wanted) : undefined;
        setTarget((chosen) => chosen || (first ? `agent:${first.id}` : ''));
      },
      (caught: unknown) => current && setAgents(asApiError(caught)),
    );
    return () => {
      current = false;
    };
  }, [wanted, filed, attempt]);

  // Teams only add choices: without them the form still gives a task to an agent.
  useEffect(() => {
    let current = true;
    api<{ teams: TeamSummary[] }>('/api/teams').then(
      (data) => current && setTeams(data.teams),
      () => undefined,
    );
    setProjects(undefined);
    api<{ projects: ProjectSummary[] }>('/api/projects').then(
      (data) => {
        if (!current) return;
        setProjects(data.projects);
        // The only project there is needs no choosing.
        const [only, ...more] = data.projects;
        if (only && more.length === 0 && !wanted) setProjectId((chosen) => chosen || only.id);
      },
      (caught: unknown) => current && setProjects(asApiError(caught)),
    );
    if (wanted && !filed) {
      api<Agent>(`/api/agents/${wanted}`).then(
        (agent) => {
          if (!current) return;
          const on = agent.projects.map((project) => project.id);
          setWantedOn(on);
          setProjectId((chosen) => chosen || (on[0] ?? ''));
        },
        () => current && setWantedOn([]),
      );
    }
    return () => {
      current = false;
    };
  }, [wanted, filed, attempt]);

  // A project with a team hands its tasks to that team, so choosing it chooses the team too.
  useEffect(() => {
    let current = true;
    setProject(undefined);
    if (projectId) {
      api<ProjectView>(`/api/projects/${projectId}`).then(
        (view) => current && setProject(view),
        () => undefined,
      );
    }
    return () => {
      current = false;
    };
  }, [projectId]);

  // The agent whose Run opened the dialog takes the task if it is on the project; else the
  // project's team; else the chosen agent if it is on the project, else the first of the
  // person's agents that is.
  useEffect(() => {
    if (!project || !Array.isArray(agents)) return;
    const on = (id: string) => project.agents.some((agent) => agent.id === id);
    if (wanted && on(wanted)) return setTarget(`agent:${wanted}`);
    if (project.team) return setTarget(`team:${project.team.id}`);
    const mine = agents.filter((agent) => on(agent.id));
    setTarget((chosen) =>
      chosen.startsWith('agent:') && on(chosen.slice('agent:'.length))
        ? chosen
        : mine[0]
          ? `agent:${mine[0].id}`
          : '',
    );
  }, [project, agents, wanted]);

  const team = target.startsWith('team:')
    ? teams.find((option) => `team:${option.id}` === target)
    : undefined;
  const agentId = team ? team.lead.id : target.replace(/^agent:/, '');

  useEffect(() => {
    let current = true;
    const take = (list: string[]) => {
      if (!current) return;
      setKnown(list);
      // Read before the ref moves on: React runs the updater later.
      const before = offered.current;
      setRepository((typed) =>
        typed.trim() === '' || before.includes(typed.trim()) ? (list[0] ?? '') : typed,
      );
      offered.current = list;
    };
    take(project?.repositories ?? []);
    return () => {
      current = false;
    };
  }, [project]);

  function show(problems: Partial<Record<Key, string>>) {
    setErrors(problems);
    const first = order.find((key) => problems[key]);
    form.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus();
  }
  const edit = (key: Key, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors((was) => ({ ...was, [key]: undefined }));
  };

  async function create(event: FormEvent) {
    event.preventDefault();
    if (props.pending) return;
    const where = repository.trim();
    const problems: Partial<Record<Key, string>> = {
      projectId: projectId ? undefined : 'Choose the project the task is filed in.',
      agentId: agentId ? undefined : 'Choose the agent or the team that does the task.',
      title: title.trim() ? undefined : 'Enter a title for the task.',
      repository: where ? repositoryProblem(where) : undefined,
    };
    if (Object.values(problems).some(Boolean)) return show(problems);
    props.setPending(true);
    setFailure(undefined);
    try {
      const created = await api<{ task: Task; run: { id: string } | null }>('/api/tasks', {
        body: {
          agentId,
          projectId,
          title,
          body,
          // A project's task in its main repository keeps none of its own: it follows the project.
          repository: where === main ? null : where || null,
          run: runNow,
        },
      });
      props.setPending(false);
      // The sidebar marks the agent while its run waits.
      if (created.run) void sidebar.reload();
      props.onCreated();
      // A queued run is what the person wants to watch; its page follows it live.
      navigate(created.run ? `/runs/${created.run.id}` : `/tasks/${created.task.id}`);
    } catch (caught) {
      props.setPending(false);
      const error = asApiError(caught);
      const byField = fieldErrors(error);
      if (error.code === 'agent_archived' || error.code === 'not_found') {
        show({ agentId: error.message });
      } else if (order.some((key) => byField[key])) show(byField);
      else setFailure(error.message);
    }
  }

  const main = project?.repositories[0];
  const projectName =
    (Array.isArray(projects) ? projects : []).find((option) => option.id === projectId)?.name ??
    project?.name;
  // Only the project's agents work on its tasks, and a team whose lead is one of them.
  const onProject = (id: string) => !project || project.agents.some((agent) => agent.id === id);
  const offeredAgents = (Array.isArray(agents) ? agents : []).filter((agent) =>
    onProject(agent.id),
  );
  const offeredTeams = teams.filter((option) => onProject(option.lead.id));
  const wantedName = (Array.isArray(agents) ? agents : []).find(
    (agent) => agent.id === wanted,
  )?.name;
  // Why the list of agents is empty, and where to change that.
  const unassigned =
    wantedOn?.length === 0 && wantedName
      ? { text: `${wantedName} is on no project yet.`, link: 'Add it to one', to: '/projects' }
      : project && offeredAgents.length === 0 && offeredTeams.length === 0
        ? {
            text: `None of your agents is on ${project.name} yet.`,
            link: 'Add one on its page',
            to: `/projects/${project.id}`,
          }
        : undefined;
  const forName =
    team?.name ?? (Array.isArray(agents) ? agents : []).find((agent) => agent.id === agentId)?.name;
  const problems = order.flatMap((key) => (errors[key] ? [[key, errors[key]] as const] : []));
  const described = (key: Key) =>
    errors[key] ? { 'aria-invalid': true as const, 'aria-describedby': `${ids}-${key}` } : {};
  const note = !runNow
    ? 'The task waits until you run it'
    : !seat
      ? 'No computer is connected yet, so the run waits for one'
      : seat.busy
        ? `Runs on ${seat.name} when it’s free`
        : seat.activity === 'Offline'
          ? `Runs on ${seat.name} when it’s online`
          : `Runs on ${seat.name} now`;

  return (
    <form
      ref={form}
      onSubmit={create}
      noValidate
      className="flex flex-col"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        form.current?.requestSubmit();
      }}
    >
      {/* A phone's sheet has Cancel on the left and the title in the middle; a wide screen, the
          title on the left and a close button on the right. */}
      <div className="flex items-center gap-2 pt-3 pr-3 pl-5 max-md:grid max-md:grid-cols-[1fr_auto_1fr] max-md:border-b max-md:border-line max-md:px-2 max-md:py-2">
        <D.DialogClose asChild>
          <Button variant="quiet" type="button" className="justify-self-start md:hidden">
            Cancel
          </Button>
        </D.DialogClose>
        <D.DialogTitle className="text-ui text-ink-2 max-md:text-section max-md:text-ink">
          New task
        </D.DialogTitle>
        <D.DialogDescription className="sr-only">
          Tell an agent or a team what to do and where to do it.
        </D.DialogDescription>
        <D.DialogClose asChild>
          <Button
            variant="quiet"
            size="icon-sm"
            type="button"
            aria-label="Close"
            className="ml-auto max-md:hidden"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </D.DialogClose>
      </div>
      <div className="grid gap-1.5 px-5 pt-3 max-md:px-4 max-md:pt-4">
        <textarea
          data-field="title"
          aria-label="Title"
          placeholder="Task title"
          rows={1}
          maxLength={200}
          value={title}
          {...described('title')}
          className="field-sizing-content resize-none bg-transparent text-title text-ink outline-none placeholder:text-ink-3"
          // A title is one line: Enter goes on to the description, as Tab does.
          onChange={(event) => edit('title', setTitle)(event.target.value.replace(/\n/g, ' '))}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            form.current?.querySelector<HTMLElement>('[data-field="body"]')?.focus();
          }}
        />
        <textarea
          data-field="body"
          aria-label="Description"
          placeholder="Describe what to do. Markdown, it goes to the agent as it is."
          value={body}
          className="field-sizing-content max-h-[50dvh] min-h-16 resize-none bg-transparent text-read text-ink outline-none placeholder:text-ink-3 max-md:max-h-[40dvh] max-md:min-h-11"
          onChange={(event) => edit('body', setBody)(event.target.value)}
        />
      </div>
      <div className="grid gap-3 px-5 pt-3 pb-4 max-md:px-4">
        {agents === undefined || projects === undefined ? (
          <p role="status" className="flex h-7 items-center text-small text-ink-3">
            Loading agents…
          </p>
        ) : !Array.isArray(agents) ? (
          <ErrorState title="Couldn't load your agents" onRetry={() => setAttempt((n) => n + 1)}>
            {agents.message}
          </ErrorState>
        ) : agents.length === 0 ? (
          <p className="text-ink-2">
            You have no agents yet.{' '}
            <Link to="/agents" className="font-medium text-ink underline underline-offset-2">
              Create an agent
            </Link>{' '}
            first, then give it a task.
          </p>
        ) : !Array.isArray(projects) ? (
          <ErrorState title="Couldn't load the projects" onRetry={() => setAttempt((n) => n + 1)}>
            {projects.message}
          </ErrorState>
        ) : projects.length === 0 ? (
          <p className="text-ink-2">
            Every task is filed in a project.{' '}
            <Link to="/projects" className="font-medium text-ink underline underline-offset-2">
              Create a project
            </Link>
            , add your agents to it, then give them tasks.
          </p>
        ) : (
          <div role="group" aria-label="About this task" className="flex flex-wrap gap-1.5">
            <Select value={projectId} onValueChange={edit('projectId', setProjectId)}>
              <SelectChip
                data-field="projectId"
                aria-label={`Project: ${projectName ?? 'none yet'}`}
                {...described('projectId')}
                className="aria-invalid:border-failed"
              >
                {projectId ? (
                  <Tint id={projectId} kind="project" />
                ) : (
                  <Folder aria-hidden="true" className="text-ink-3" />
                )}
                <span className={cn('truncate', !projectName && 'text-ink-3')}>
                  {projectName ?? 'Choose a project'}
                </span>
              </SelectChip>
              <SelectContent>
                {projects.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={target} onValueChange={edit('agentId', setTarget)}>
              <SelectChip
                data-field="agentId"
                aria-label={`For: ${forName ?? 'nobody yet'}`}
                {...described('agentId')}
                className="aria-invalid:border-failed"
              >
                {team ? (
                  <Tint id={team.id} kind="team" />
                ) : forName ? (
                  <AgentTile id={agentId} name={forName} className="size-4.5" />
                ) : (
                  <UserRound aria-hidden="true" className="text-ink-3" />
                )}
                <span className={cn('truncate', !forName && 'text-ink-3')}>
                  {forName ?? 'Choose an agent or a team'}
                </span>
              </SelectChip>
              <SelectContent>
                {offeredTeams.length > 0 && (
                  <SelectGroup label="Teams">
                    {offeredTeams.map((option) => (
                      <SelectItem
                        key={option.id}
                        value={`team:${option.id}`}
                        description={`Led by ${option.lead.name}, who splits the task`}
                      >
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                <SelectGroup label="Agents">
                  {offeredAgents.map((agent) => (
                    <SelectItem
                      key={agent.id}
                      value={`agent:${agent.id}`}
                      description={agent.roleTitle || undefined}
                    >
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <RepositoryPicker
              value={repository}
              repositories={known}
              main={main}
              onChange={edit('repository', setRepository)}
              trigger={
                <button
                  type="button"
                  data-field="repository"
                  aria-label={`Where it works: ${repository.trim() || 'no repository'}`}
                  {...described('repository')}
                  className={cn(fieldChip, 'aria-invalid:border-failed')}
                >
                  <Where where={repository.trim()} />
                </button>
              }
            />
          </div>
        )}
        {unassigned && (
          <p className="text-small text-ink-2">
            {unassigned.text}{' '}
            <Link to={unassigned.to} className="font-medium text-ink underline underline-offset-2">
              {unassigned.link}
            </Link>{' '}
            to give it tasks.
          </p>
        )}
        {problems.length > 0 && (
          <div className="grid gap-1 text-small text-failed">
            {problems.map(([key, message]) => (
              <p key={key} id={`${ids}-${key}`}>
                {message}
              </p>
            ))}
          </div>
        )}
        {failure && <FormError>{failure}</FormError>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line py-3 pr-4 pl-5 max-md:px-4">
        <p className="flex min-w-0 items-center gap-2 text-small text-ink-3 max-md:basis-full">
          <Laptop aria-hidden="true" className="size-3.5 shrink-0" />
          {note}
        </p>
        <span className="ml-auto flex items-center gap-2 max-md:ml-0">
          <Switch id={`${ids}-run`} checked={runNow} onCheckedChange={setRunNow} />
          <label htmlFor={`${ids}-run`} className="text-ui text-ink-2">
            Run now
          </label>
        </span>
        <Button
          variant="primary"
          type="submit"
          disabled={
            !Array.isArray(agents) ||
            agents.length === 0 ||
            !Array.isArray(projects) ||
            projects.length === 0
          }
          title="⌘↵"
          className="max-md:ml-auto"
        >
          {runNow ? 'Create and run' : 'Create task'}
        </Button>
      </div>
    </form>
  );
}
