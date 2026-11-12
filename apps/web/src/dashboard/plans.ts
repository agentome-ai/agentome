import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { RunEvent } from '../runs/run-data';
import { planOf } from '../runs/run-plan';

// How far each run at work is through its plan, for the dashboard's Running now, and what it is at,
// for a running run's card on Runs. Both are in the run's events (run-plan.tsx), so the page keeps
// each run's events and asks only for the ones after the last it has: the first look reads the
// transcript, later ones a few events.

export type Progress = { done: number; total: number; current: number | null; active: string };

type Page = { events: RunEvent[]; nextAfter: number | null };
type Kept = { after: number; events: RunEvent[] };

export function progressOf(events: readonly RunEvent[]): Progress | null {
  const steps = planOf(events);
  if (steps.length === 0) return null;
  const current = steps.findIndex((step) => step.status === 'in_progress');
  return {
    done: steps.filter((step) => step.status === 'completed').length,
    total: steps.length,
    current: current === -1 ? null : current,
    active: steps[current]?.active ?? '',
  };
}

/** The plan progress of each of `ids`, asked again whenever `tick` changes. */
export function usePlans(ids: readonly string[], tick: unknown) {
  const events = useRunEvents(ids, tick);
  return useMemo(() => new Map([...events].map(([id, list]) => [id, progressOf(list)])), [events]);
}

/** The events of each of `ids` so far, read on from the last one whenever `tick` changes. */
export function useRunEvents(ids: readonly string[], tick: unknown) {
  const kept = useRef(new Map<string, Kept>());
  const [events, setEvents] = useState<ReadonlyMap<string, readonly RunEvent[]>>(new Map());
  const key = ids.join(',');
  useEffect(() => {
    let current = true;
    void (async () => {
      // Read into copies: a look the next one overtook keeps nothing.
      const fresh = new Map<string, Kept>();
      for (const id of key ? key.split(',') : []) {
        const run = { ...(kept.current.get(id) ?? { after: -1, events: [] }) };
        try {
          for (let more = true; more;) {
            const page = await api<Page>(`/api/runs/${id}/events?after=${run.after}`);
            run.events = [...run.events, ...page.events];
            run.after = page.events.at(-1)?.seq ?? run.after;
            more = page.nextAfter !== null;
          }
        } catch {
          // The page goes on without the rest of this run's events; the next look asks again.
        }
        fresh.set(id, run);
      }
      if (!current) return;
      // A run no longer at work is let go with its events.
      kept.current = fresh;
      setEvents(new Map([...fresh].map(([id, run]) => [id, run.events])));
    })();
    return () => {
      current = false;
    };
  }, [key, tick]);
  return events;
}
