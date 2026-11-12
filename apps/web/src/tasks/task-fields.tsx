import { Calendar } from 'lucide-react';
import { Link } from 'react-router';
import { formatWhen } from '../runs/run-data';
import { fieldChip } from '../ui/chip';
import { cn } from '../ui/cn';
import { AgentTile, Tint } from '../ui/tint';
import { Where } from './repository-picker';
import { ChangeRepository } from './task-repository';
import { TaskStatusMark } from './task-status';
import type { Task } from './tasks-data';

/**
 * The task's properties as Linear's chips under its title, where a narrow screen has no room for
 * the column beside it: its status, agent, project, repository and when it was made.
 */
export function TaskFields(props: {
  task: Task;
  onSaved: (task: Task) => void;
  className?: string;
}) {
  const { task } = props;
  return (
    <div className={cn('grid gap-2', props.className)}>
      <div aria-label="About this task" role="group" className="flex flex-wrap gap-1.5">
        <span className={fieldChip}>
          <TaskStatusMark status={task.status} run={task.latestRun} />
        </span>
        <Link to={`/agents/${task.agent.id}`} className={fieldChip}>
          <AgentTile id={task.agent.id} name={task.agent.name} className="size-4.5" />
          <span className="truncate">
            {task.agent.name}
            {task.agent.status === 'archived' && <span className="text-ink-3">, archived</span>}
          </span>
        </Link>
        {task.project && (
          <Link to={`/projects/${task.project.id}`} className={fieldChip}>
            <Tint id={task.project.id} kind="project" />
            <span className="truncate">{task.project.name}</span>
          </Link>
        )}
        <ChangeRepository
          task={task}
          onSaved={props.onSaved}
          trigger={
            <button
              type="button"
              className={fieldChip}
              aria-label={`Works in: ${task.repository ?? 'no repository'}. Change`}
            >
              <Where where={task.repository ?? ''} />
            </button>
          }
        />
        <span className={fieldChip}>
          <Calendar aria-hidden="true" className="text-ink-2" />
          <span className="truncate">
            <span className="text-ink-3">Created</span> {formatWhen(task.createdAt)} by{' '}
            {task.createdBy.name}
          </span>
        </span>
      </div>
      {/* A step Jira refused, as a renamed status: it stays here until one goes through. */}
      {task.externalError && <p className="text-small text-failed">Jira: {task.externalError}</p>}
    </div>
  );
}
