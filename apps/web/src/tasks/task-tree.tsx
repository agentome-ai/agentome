import { Link } from 'react-router';
import { textLink } from '../ui/properties';
import { TaskStatusMark } from './task-status';
import type { Task } from './tasks-data';

// Who assigned the task and what its agent assigned to the leads under it. Each
// assigned task runs apart with its lead's team; the lead runs again when all have ended.

export function AssignedBy({ parent }: { parent: NonNullable<Task['parent']> }) {
  return (
    <p className="mb-6 text-ink-2">
      {parent.agent} assigned this as part of{' '}
      <Link to={`/tasks/${parent.id}`} className={textLink}>
        {parent.title}
      </Link>
      . When it ends, the summary goes back to them.
    </p>
  );
}

export function AssignedTasks({ task }: { task: Task }) {
  if (task.subtasks.length === 0) return null;
  return (
    <section aria-labelledby="assigned" className="mt-10">
      <h2 id="assigned" className="mb-1 text-section">
        Assigned
      </h2>
      <p className="mb-3 text-small text-ink-3">
        {task.agent.name} runs again with their reports once every one has ended.
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {task.subtasks.map((subtask) => (
          <li key={subtask.id} className="flex items-center gap-3 px-4 py-3">
            <span className="grid min-w-0 flex-1 gap-0.5">
              <Link to={`/tasks/${subtask.id}`} className="truncate font-medium hover:underline">
                {subtask.title}
              </Link>
              <span className="truncate text-small text-ink-3">{subtask.agent}</span>
            </span>
            <TaskStatusMark
              status={subtask.status}
              run={subtask.runStatus && { status: subtask.runStatus }}
              className="shrink-0 text-small"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
