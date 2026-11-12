import { useEffect, useRef, useState } from 'react';
import { isLive, type RunEvent, type RunStatus } from './run-data';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'ended';

// Events of one burst land in one render: a long transcript arrives a thousand at a time.
const BATCH_MS = 50;
const RETRY_MAX_MS = 15_000;

/**
 * The events of a run as GET /api/runs/:id/stream sends them. A dropped stream comes back after
 * 1, 2, 4… up to 15 s, from the last seq it has; a seq that arrives twice counts once. It says
 * `reconnecting` once a retry has failed too. `onChange`
 * hears every status the server sends, and null for every drop: the page then reloads the run,
 * which may have ended meanwhile or may not be the person's to read any more.
 */
export function useRunStream(runId: string, onChange: (status: RunStatus | null) => void) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const notify = useRef(onChange);
  notify.current = onChange;

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let pending: RunEvent[] = [];
    let last = -1;
    let drops = 0;
    let ended = false;
    setEvents([]);
    setConnection('connecting');

    const deliver = () => {
      flush = undefined;
      const batch = pending;
      pending = [];
      setEvents((all) => [...all, ...batch]);
    };
    // Live once something arrives, not on open: the server answers 200 before it reads the
    // run, and a stream that opens and then fails at once must count as a failed retry.
    const alive = () => {
      drops = 0;
      setConnection((now) => (now === 'ended' ? now : 'live'));
    };
    const connect = () => {
      source = new EventSource(`/api/runs/${runId}/stream?after=${last}`);
      source.addEventListener('run', (message) => {
        alive();
        const event = JSON.parse(message.data) as RunEvent;
        if (event.seq <= last) return;
        last = event.seq;
        pending.push(event);
        flush ??= setTimeout(deliver, BATCH_MS);
      });
      source.addEventListener('status', (message) => {
        alive();
        // The events sent before a status land with it: what reads the whole transcript once
        // the run has ended (the report card) never sees half of it.
        if (flush !== undefined) {
          clearTimeout(flush);
          deliver();
        }
        const { status } = JSON.parse(message.data) as { status: RunStatus };
        // The server closes after an ended run's status; closing first keeps the browser
        // from reconnecting on its own.
        if (!isLive(status)) {
          ended = true;
          source?.close();
          setConnection('ended');
        }
        notify.current(status);
      });
      source.addEventListener('error', () => {
        source?.close();
        if (ended) return;
        // One drop is routine (a proxy, a restart) and heals in a second; a failed retry is not.
        if (drops > 0) setConnection('reconnecting');
        notify.current(null);
        retry = setTimeout(connect, Math.min(RETRY_MAX_MS, 1000 * 2 ** drops));
        drops += 1;
      });
    };
    connect();
    return () => {
      ended = true;
      source?.close();
      clearTimeout(retry);
      clearTimeout(flush);
    };
  }, [runId]);

  return { events, connection };
}
