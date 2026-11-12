import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../api';
import type { ProjectView } from '../projects/projects-data';
import { RepositoryPicker } from './repository-picker';
import type { Task } from './tasks-data';

/**
 * Change on where the task's next run starts, through the picker behind `trigger`. A project's
 * task is offered the project's repositories; its main one is none of the task's own, so the
 * task follows the project again.
 */
export function ChangeRepository(props: {
  task: Task;
  onSaved: (task: Task) => void;
  trigger: ReactNode;
}) {
  const { task } = props;
  const projectId = task.project?.id;
  const [offered, setOffered] = useState<string[]>([]);

  useEffect(() => {
    if (!projectId) return setOffered([]);
    let current = true;
    api<ProjectView>(`/api/projects/${projectId}`).then(
      (project) => current && setOffered(project.repositories),
      () => current && setOffered([]),
    );
    return () => {
      current = false;
    };
  }, [projectId]);

  const main = projectId ? offered[0] : undefined;
  return (
    <RepositoryPicker
      value={task.repository ?? ''}
      repositories={offered}
      main={main}
      trigger={props.trigger}
      onChange={async (value) => {
        const next = await api<Task>(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          body: { repository: value === main ? null : value || null },
        });
        props.onSaved(next);
      }}
    />
  );
}
