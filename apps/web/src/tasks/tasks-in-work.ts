import { useEffect, useState } from 'react';
import { api } from '../api';
import { isInWork, type TaskPage } from './tasks-data';

// The sidebar's count of the person's tasks in work. Nothing waits on the person here, so it
// asks less often than Approvals, and a failed poll keeps the last count.
const REFRESH_MS = 15_000;

/** How many of the person's open tasks have a run going; 0 until the first answer. */
export function useTasksInWork(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const reload = () =>
      api<TaskPage>('/api/tasks?status=open&limit=100').then(
        (page) => setCount(page.tasks.filter(isInWork).length),
        () => undefined,
      );
    void reload();
    const tick = () => document.visibilityState === 'visible' && void reload();
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return count;
}
