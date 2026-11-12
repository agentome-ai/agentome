import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAgents } from '../agents/agents-data';
import { type ApiError, api, asApiError } from '../api';
import { isLive } from '../runs/run-data';
import { ApiErrorState } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Properties, Property, textLink } from '../ui/properties';
import { formatWhen } from '../runs/run-data';
import { TaskActivity } from './task-activity';
import { Prose } from './prose';
import { TaskStatusMark } from './task-status';
import type { Task, TaskStatus } from './tasks-data';
import { WaitingHere } from '../approvals/waiting-here';
import { TaskChangesSection } from './task-changes';
import { AssignedBy, AssignedTasks } from './task-tree';
import { isFolder } from './repository-picker';
import { ChangeRepository } from './task-repository';
import { TaskFields } from './task-fields';
import { InPlace } from '../ui/in-place';
import { Tint } from '../ui/tint';

// A run's status changes on its own while it goes, so the page asks again this often.
const REFRESH_MS = 5_000;

/** /tasks/:id: what the task asks for, where, and how its runs went. */
export function TaskPage() {
  const { id = '' } = useParams();
  // Another task is another page: nothing of this one's state carries over.
  return <TaskView key={id} id={id} />;
}

function TaskView({ id }: { id: string }) {
  const sidebar = useAgents();
  const ids = useId();
  const path = `/api/tasks/${encodeURIComponent(id)}`;
  const [task, setTask] = useState<Task>();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  // Answers apply in the order their requests left, and no poll leaves while the status
  // changes: a poll that read the task before Mark as done cannot put the old status back.
  const latest = useRef(0);
  const changing = useRef(false);

  const load = useCallback(
    async (poll = false) => {
      if (poll && changing.current) return;
      const ticket = ++latest.current;
      try {
        const next = await api<Task>(path);
        if (ticket !== latest.current) return;
        setTask(next);
        setError(undefined);
      } catch (caught) {
        if (ticket === latest.current) setError(asApiError(caught));
      }
    },
    [path],
  );
  useEffect(() => void load(), [load]);
  // A session that ended or a grant that lapsed ends the page, even with a task on it.
  const gone = error?.code === 'not_found' || error?.code === 'validation_failed';
  const stopped = gone || error?.code === 'unauthorized';
  const going = !stopped && (task?.runs.some((run) => isLive(run.status)) ?? false);
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => void load(true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [going, load]);

  async function change(status: TaskStatus) {
    if (busy) return;
    setBusy(true);
    changing.current = true;
    const ticket = ++latest.current;
    try {
      const next = await api<Task>(path, { method: 'PATCH', body: { status } });
      if (ticket === latest.current) setTask(next);
    } catch (caught) {
      const what =
        status === 'done' ? "Couldn't mark the task as done" : "Couldn't reopen the task";
      toast.error(what, { description: asApiError(caught).message });
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }

  /** Changes the title or the description; answers why it could not. */
  async function edit(changes: { title: string } | { body: string }) {
    changing.current = true;
    const ticket = ++latest.current;
    try {
      const next = await api<Task>(path, { method: 'PATCH', body: changes });
      if (ticket === latest.current) setTask(next);
      return undefined;
    } catch (caught) {
      return asApiError(caught).message;
    } finally {
      changing.current = false;
    }
  }

  // Run again turns itself off once a run is going: focus then moves to the newest run, first
  // in the list, instead of dropping out of the page.
  const runButton = useRef<HTMLButtonElement>(null);
  const runsList = useRef<HTMLElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    if (runButton.current?.disabled) {
      // The newest run is the last in the activity.
      [...(runsList.current?.querySelectorAll<HTMLElement>('a[href^="/runs/"]') ?? [])]
        .at(-1)
        ?.focus();
    }
  }, [refocus, task]);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`${path}/run`, { method: 'POST' });
      // The sidebar marks the agent while its run waits.
      void sidebar.reload();
    } catch (caught) {
      toast.error("Couldn't run the task", { description: asApiError(caught).message });
    }
    // Either way the runs changed, or the answer shows why not.
    await load();
    setBusy(false);
    setRefocus(true);
  }

  const header = (title: string, actions?: ReactNode, heading?: ReactNode) => (
    <PageHeader
      title={title}
      crumbs={[{ label: 'Tasks', to: '/tasks' }]}
      actions={actions}
      ownHeading={heading}
      big
    />
  );
  if (gone) {
    const all = (
      <Button asChild>
        <Link to="/tasks">All tasks</Link>
      </Button>
    );
    return (
      <>
        {header('Task not found')}
        <EmptyState title="This task doesn't exist or isn't shared with you" action={all}>
          Check the link, or pick a task from the list.
        </EmptyState>
      </>
    );
  }
  if (!task || error?.code === 'unauthorized') {
    return (
      <>
        {header('Task')}
        <div className={cn(frame.wide, 'pt-6')}>
          {error ? (
            <ApiErrorState title="Couldn't load the task" error={error} onRetry={load} />
          ) : (
            <LoadingState label="Loading the task" />
          )}
        </div>
      </>
    );
  }

  const done = task.status === 'done';
  const archived = task.agent.status === 'archived';
  const reason = archived
    ? 'Unarchive the agent to run this task.'
    : going
      ? 'Available when the current run ends.'
      : undefined;
  return (
    <>
      {header(
        task.title,
        <>
          {/* Not disabled while it saves: focus would drop out of the page. */}
          <Button onClick={() => void change(done ? 'open' : 'done')}>
            {done ? 'Reopen' : 'Mark as done'}
          </Button>
          <Button
            ref={runButton}
            variant="primary"
            disabled={reason !== undefined}
            aria-describedby={reason && `${ids}-reason`}
            onClick={() => void run()}
          >
            {task.runs.length ? 'Run again' : 'Run'}
          </Button>
        </>,
        <InPlace
          label="Title"
          text={task.title}
          oneLine
          fieldClassName="text-name"
          heading
          onSave={(title) => (title ? edit({ title }) : Promise.resolve('A task needs a title.'))}
        >
          <h1 className="text-name">{task.title}</h1>
        </InPlace>,
      )}
      {/* The run page's skeleton: what the task says on the left, what it is on the right. */}
      <div
        className={cn(
          'grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-8 pt-6 pb-24 lg:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_340px]',
          frame.wide,
        )}
      >
        {/* The properties beside the document, ruled off as Linear's are. */}
        <aside
          aria-label="About this task"
          className="min-w-0 max-lg:hidden lg:sticky lg:top-19 lg:order-2 lg:self-start lg:border-l lg:border-line lg:pl-8"
        >
          <Properties>
            <Property label="Status">
              <TaskStatusMark status={task.status} run={task.latestRun} />
            </Property>
            <Property label="Agent">
              <Link to={`/agents/${task.agent.id}`} className={textLink}>
                {task.agent.name}
              </Link>
              {archived && <span className="text-ink-3">, archived</span>}
            </Property>
            {task.project && (
              <Property label="Project">
                <Tint id={task.project.id} kind="project" className="mr-1.5" />
                <Link to={`/projects/${task.project.id}`} className={textLink}>
                  {task.project.name}
                </Link>
              </Property>
            )}
            <Property label="Works in">
              {task.repository ? (
                <code className="break-all">{task.repository}</code>
              ) : task.project ? (
                <span className="text-ink-3">
                  {task.project.name} has no repository yet. Add one on the project's page.
                </span>
              ) : (
                <span className="text-ink-3">
                  No repository. Each run starts in a new, empty one.
                </span>
              )}
              {task.project && task.repositoryFromProject ? (
                <span className="block text-small text-ink-3">
                  The main repository of{' '}
                  <Link to={`/projects/${task.project.id}`} className={textLink}>
                    {task.project.name}
                  </Link>
                </span>
              ) : (
                task.repository &&
                isFolder(task.repository) && (
                  <span className="block text-small text-ink-3">
                    A folder on the computer that runs the task. Its commits come back to it as a
                    branch.
                  </span>
                )
              )}
              <ChangeRepository
                task={task}
                onSaved={setTask}
                trigger={
                  <Button size="sm" variant="quiet" className="-ml-2">
                    Change
                  </Button>
                }
              />
            </Property>
            {/* A step Jira refused, as a renamed status: it stays here until one goes through. */}
            {task.externalError && (
              <Property label="Jira">
                <span className="text-failed">{task.externalError}</span>
              </Property>
            )}
            <Property label="Created">
              {formatWhen(task.createdAt)} by {task.createdBy.name}
            </Property>
          </Properties>
        </aside>

        <div className="max-w-205 min-w-0 lg:order-1">
          <TaskFields task={task} onSaved={setTask} className="mb-6 lg:hidden" />
          <WaitingHere which={(call) => call.task?.id === task.id} />
          {task.parent && <AssignedBy parent={task.parent} />}
          {/* The task's own text, with no heading of ours: it would read as one of its own. */}
          <section aria-label="Description">
            <InPlace
              label="Description"
              text={task.body}
              fieldClassName="min-h-24 text-read"
              onSave={(body) => edit({ body })}
              note={
                going
                  ? 'Saves when you click away. The run going now keeps the old text; the next one reads this.'
                  : 'Saves when you click away; Esc puts the text back. The next run reads this.'
              }
            >
              <Description body={task.body} />
            </InPlace>
          </section>
          <TaskChangesSection task={task} />
          <AssignedTasks task={task} />

          <TaskActivity
            ref={runsList}
            task={task}
            cannotRun={reason}
            onCommented={async () => {
              void sidebar.reload();
              await load();
            }}
            aside={
              reason && (
                <span id={`${ids}-reason`} className="text-small text-ink-3">
                  {reason}
                </span>
              )
            }
          />
        </div>
      </div>
    </>
  );
}

function Description({ body }: { body: string }) {
  if (!body.trim()) return <p className="text-ink-3">No description.</p>;
  return <Prose>{body}</Prose>;
}
