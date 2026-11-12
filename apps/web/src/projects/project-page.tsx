import { Ellipsis, Folder } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { type ApiError, api, asApiError } from '../api';
import { formatDuration, formatUsd } from '../runs/run-data';
import { ApiErrorState, useMe } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Combobox } from '../ui/combobox';
import * as D from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { FormError } from '../ui/field';
import { InPlace } from '../ui/in-place';
import { Section } from '../ui/section';
import { AgentTile, tintOf } from '../ui/tint';
import { KnowledgeSection } from './knowledge-section';
import { Row } from '../ui/list-row';
import { NewProjectTask, ProjectFields } from './project-fields';
import type { ProjectView } from './projects-data';
import { RepositoriesSection } from './repositories-section';
import { Triggers } from './triggers';

/** Markdown as it was written: until the renderer loads, or if it cannot. */
const Plain = ({ children }: { children: string }) => (
  <p className="markdown whitespace-pre-wrap">{children}</p>
);
const Markdown = lazy(() =>
  import('../ui/markdown').then(
    ({ Markdown }) => ({ default: Markdown }),
    () => ({ default: Plain }),
  ),
);

/** One project: what it is for, which agents work on it, and where their code goes. */
export function ProjectPage() {
  const { id = '' } = useParams();
  const me = useMe();
  const [project, setProject] = useState<ProjectView>();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  // Only the answer for the project on screen counts: a slow one for the project left behind
  // would otherwise paint itself under this URL.
  const wanted = useRef(id);

  const load = useCallback(async () => {
    wanted.current = id;
    setError(undefined);
    try {
      const view = await api<ProjectView>(`/api/projects/${id}`);
      if (wanted.current === id) setProject(view);
    } catch (caught) {
      if (wanted.current === id) setError(asApiError(caught));
    }
  }, [id]);
  useEffect(() => {
    setProject(undefined);
    void load();
  }, [load]);

  const crumbs = [{ label: 'Projects', to: '/projects' }];
  if (error || !project) {
    return (
      <>
        <PageHeader title="Project" crumbs={crumbs} width="read" />
        <div className={cn(frame.read, 'pt-6')}>
          {error ? (
            <ApiErrorState title="Couldn't load this project" error={error} onRetry={load} />
          ) : (
            <LoadingState label="Loading the project" />
          )}
        </div>
      </>
    );
  }

  async function remove(agent: { id: string; name: string }) {
    setBusy(true);
    try {
      await api(`/api/projects/${id}/agents/${agent.id}`, { method: 'DELETE' });
      await load();
    } catch (caught) {
      toast.error(`Couldn't take ${agent.name} off this project`, {
        description: asApiError(caught).message,
      });
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = me.role === 'admin';
  // Its maker changes it as an admin does; its connections and repositories stay an admin's.
  const canEdit = isAdmin || project?.createdBy === me.id;
  /** Changes the name, the description or the goals; answers why it could not. */
  async function edit(changes: { name: string } | { description: string } | { goals: string }) {
    try {
      setProject(await api<ProjectView>(`/api/projects/${id}`, { method: 'PATCH', body: changes }));
      return undefined;
    } catch (caught) {
      return asApiError(caught).message;
    }
  }
  const lead = project.team?.lead.id;
  const heading = (
    <div className="grid justify-items-start gap-3.5">
      <span
        aria-hidden="true"
        className={cn(
          'grid size-9 place-items-center rounded-lg border border-current/25 bg-current/10',
          tintOf(project.id),
        )}
      >
        <Folder className="size-4.5" />
      </span>
      {canEdit ? (
        <InPlace
          label="Name"
          text={project.name}
          oneLine
          fieldClassName="text-name"
          heading
          onSave={(name) => (name ? edit({ name }) : Promise.resolve('A project needs a name.'))}
        >
          <h1 className="text-name">{project.name}</h1>
        </InPlace>
      ) : (
        <h1 className="text-name">{project.name}</h1>
      )}
    </div>
  );
  return (
    <>
      <PageHeader
        title={project.name}
        crumbs={crumbs}
        width="read"
        ownHeading={heading}
        actions={
          <>
            {project.team && <NewProjectTask project={project} />}
            {canEdit && <ProjectMenu project={project} />}
          </>
        }
      />
      <div className={cn(frame.read, 'grid gap-9 pt-1.5 pb-24')}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4.5">
          <div className="grid max-w-170 gap-1">
            <Text
              label="Description"
              text={project.description}
              placeholder="Add a description: what this project is for. Agents read it with each task."
              isAdmin={isAdmin}
              onSave={(description) => edit({ description })}
            />
            <Text
              label="Goals"
              text={project.goals}
              placeholder="Add goals: what it is aiming at this quarter, if that helps an agent."
              isAdmin={isAdmin}
              onSave={(goals) => edit({ goals })}
            />
          </div>
          <ProjectFields project={project} isAdmin={canEdit} onSaved={setProject} />
        </div>

        <Week week={project.week} />

        <Section
          title="Agents"
          count={project.agents.length}
          action={canEdit && <AddAgent project={project} all={isAdmin} onAdded={load} />}
          empty={
            canEdit
              ? 'No agents work on this project yet. Add one, and its runs can reach the repositories below.'
              : 'No agents work on this project yet. Its maker or an admin adds them.'
          }
          isEmpty={project.agents.length === 0}
        >
          <ul aria-label="Agents" className="-mt-2 grid grid-cols-[minmax(0,1fr)]">
            {project.agents.map((agent) => (
              <Row
                key={agent.id}
                lead={<AgentTile id={agent.id} name={agent.name} />}
                name={
                  <Link to={`/agents/${agent.id}`} className="truncate font-medium">
                    {agent.name}
                    {agent.status === 'archived' && (
                      <span className="ml-2 font-normal text-ink-3">Archived</span>
                    )}
                  </Link>
                }
                detail={agent.roleTitle}
                tag={agent.id === lead ? 'Lead' : undefined}
                menu={
                  canEdit && (
                    <DropdownMenuItem disabled={busy} onSelect={() => void remove(agent)}>
                      Remove from project
                    </DropdownMenuItem>
                  )
                }
                what={agent.name}
              />
            ))}
          </ul>
        </Section>

        <RepositoriesSection project={project} isAdmin={isAdmin} onSaved={load} />

        <Triggers project={project} canEdit={canEdit} onSaved={setProject} />

        <KnowledgeSection
          projectId={project.id}
          repositories={project.repositories}
          isAdmin={isAdmin}
        />
      </div>
    </>
  );
}

/** The description or the goals: changed in place by an admin, an invitation while empty. */
function Text(props: {
  label: string;
  text: string;
  placeholder: string;
  isAdmin: boolean;
  onSave: (text: string) => Promise<string | undefined>;
}) {
  const read = props.text ? (
    <Suspense fallback={<Plain>{props.text}</Plain>}>
      <Markdown>{props.text}</Markdown>
    </Suspense>
  ) : (
    <p className="text-read text-ink-3">{props.placeholder}</p>
  );
  if (!props.isAdmin) return props.text ? read : null;
  return (
    <InPlace
      label={props.label}
      text={props.text}
      fieldClassName="min-h-20 text-read"
      onSave={props.onSave}
    >
      {read}
    </InPlace>
  );
}

/** The week of the runs of the project's tasks, as the dashboard's card has it. */
function Week({ week }: { week: ProjectView['week'] }) {
  if (week.runs === 0) return null;
  const numbers = [
    ['Runs this week', String(week.runs)],
    ['Done', week.ended ? `${Math.round((week.done / week.ended) * 100)}%` : '—'],
    ['Median run', week.medianSeconds === null ? '—' : formatDuration(week.medianSeconds * 1000)],
    ['Cost at API prices', week.usd === null ? '—' : formatUsd(week.usd)],
  ];
  return (
    <dl
      aria-label="This week"
      className="grid grid-cols-4 overflow-hidden rounded-lg border border-line bg-raised max-md:grid-cols-2"
    >
      {numbers.map(([label, value]) => (
        <div
          key={label}
          className="grid gap-0.5 px-3.5 py-3 not-first:border-l not-first:border-line max-md:nth-3:border-l-0 max-md:nth-[n+3]:border-t"
        >
          <dd className="text-[17px] leading-6 font-semibold tracking-[-0.01em] tabular-nums">
            {value}
          </dd>
          <dt className="order-first text-small text-ink-3">{label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** Puts an agent on this project: any of the company's for an admin, one's own for its maker. */
function AddAgent({
  project,
  all,
  onAdded,
}: {
  project: ProjectView;
  all: boolean;
  onAdded: () => Promise<void>;
}) {
  const [agents, setAgents] = useState<{ id: string; name: string; status: string }[]>([]);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    api<{ agents: { id: string; name: string; status: string }[] }>(
      all ? '/api/agents?all=true' : '/api/agents',
    ).then(
      (data) => setAgents(data.agents),
      () => setAgents([]),
    );
  }, [all]);
  const here = new Set(project.agents.map((agent) => agent.id));
  const options = agents
    .filter((agent) => !here.has(agent.id) && agent.status === 'active')
    .map((agent) => ({ value: agent.id, label: agent.name }));

  async function add(agentId: string) {
    setPending(true);
    try {
      await api(`/api/projects/${project.id}/agents/${agentId}`, { method: 'PUT' });
      await onAdded();
    } catch (caught) {
      toast.error("Couldn't add the agent", { description: asApiError(caught).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <Combobox
      value={null}
      options={options}
      trigger="icon"
      placeholder={pending ? 'Adding…' : 'Add agent'}
      searchPlaceholder="Search agents"
      emptyText="Every active agent is already on this project"
      onValueChange={(agentId) => void add(agentId)}
    />
  );
}

/** The project's other actions: Delete, asked first; the project and its connections go, its tasks stay. */
function ProjectMenu({ project }: { project: ProjectView }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const hosts = project.connections.some((connection) => connection.kind !== 'jira');

  async function remove() {
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      setOpen(false);
      await navigate('/projects');
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog open={open} onOpenChange={setOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="quiet" size="icon" aria-label="More actions">
            <Ellipsis aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="danger" onSelect={() => setOpen(true)}>
            Delete project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <D.DialogContent>
        <D.DialogTitle>Delete {project.name}?</D.DialogTitle>
        <D.DialogDescription>
          Its connections and their tokens, its knowledge and its agents' assignments go. Its tasks
          and runs stay, without the project.
          {hosts &&
            ' Webhooks that GitHub or GitLab sends to Agentome stay there until you remove them.'}
        </D.DialogDescription>
        {error && <FormError>{error}</FormError>}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </D.DialogClose>
          <Button variant="danger" disabled={pending} onClick={() => void remove()}>
            Delete project
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}
