import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { Presence } from '../ui/status';
import { PlaceTerminal } from './place-terminal';

// A person's own place on the company's server: a container of theirs, made by the platform,
// that runs their agents under their subscription while they work in Agentome. Nothing to
// install on their computer. Shown above the computers when the installation has places.

type PlaceView = {
  available: boolean;
  place: null | {
    seatId: string | null;
    state: 'none' | 'asleep' | 'awake' | 'unknown';
    signedOut: string[];
    lastSeenAt: string | null;
    agents: { id: string; name: string }[];
  };
};

const STATE: Record<NonNullable<PlaceView['place']>['state'], string> = {
  awake: 'Awake',
  asleep: 'Asleep: it wakes when one of your agents has work and you are here',
  none: 'Being made',
  unknown: 'Agentome cannot reach the place launcher right now',
};

export function PlaceSection() {
  const [view, setView] = useState<PlaceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [freshening, setFreshening] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api<PlaceView>('/api/me/place'));
    } catch {
      // A place is an extra: the computers below still load without it.
      setView({ available: false, place: null });
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (path: string, method: 'POST' | 'DELETE' = 'POST') => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<PlaceView | undefined>(path, { method });
      if (next) setView(next);
      else await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!view?.available) return null;
  const place = view.place;
  const claudeOut = place?.signedOut.includes('claude-code') ?? false;

  return (
    <section aria-labelledby="place-heading" className="mb-8 border-t border-line pt-4">
      <h2 id="place-heading" className="text-section text-ink">
        Your place on the server
      </h2>
      {place === null ? (
        <>
          <p className="mt-2 max-w-[72ch] text-read text-ink-2">
            A container of yours on the company's server. Sign in there once with your Claude or
            ChatGPT subscription, and your agents run in it while you work in Agentome. Nothing is
            installed on your computer.
          </p>
          <div className="mt-3">
            <Button variant="primary" disabled={busy} onClick={() => void act('/api/me/place')}>
              {busy ? 'Making your place…' : 'Make my place'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-read text-ink-2" aria-live="polite">
            <Presence online={place.state === 'awake'}>{STATE[place.state]}</Presence>
          </p>
          {claudeOut && (
            <p className="mt-3 max-w-[72ch] text-read text-ink-2">
              Claude Code is not signed in there yet, so the place takes no runs of Claude Code
              agents. Open the terminal, run <code>claude</code> and sign in with your subscription.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant={claudeOut ? 'primary' : 'secondary'} onClick={() => setTerminal(true)}>
              Open terminal
            </Button>
            {place.state === 'asleep' && (
              <Button disabled={busy} onClick={() => void act('/api/me/place/wake')}>
                Wake
              </Button>
            )}
            {place.state === 'awake' && (
              <Button disabled={busy} onClick={() => void act('/api/me/place/sleep')}>
                Put to sleep
              </Button>
            )}
            <Button variant="quiet" disabled={busy} onClick={() => setDeleting(true)}>
              Delete place
            </Button>
          </div>
          {place.agents.length > 0 && (
            <div className="mt-6 max-w-[72ch]">
              <h3 className="text-read font-medium text-ink">Working folders</h3>
              <p className="mt-1 text-read text-ink-2">
                Each agent keeps a folder per repository here between runs: its dependencies and
                builds stay. Start one fresh if it went wrong.
              </p>
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {place.agents.map((agent) => (
                  <li key={agent.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate text-ink">{agent.name}</span>
                    <Button variant="quiet" disabled={busy} onClick={() => setFreshening(agent)}>
                      Start fresh
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-failed">
          {error}
        </p>
      )}
      <PlaceTerminal
        open={terminal}
        onClose={() => {
          setTerminal(false);
          void load();
        }}
      />
      <D.Dialog open={freshening !== null} onOpenChange={(open) => !open && setFreshening(null)}>
        <D.DialogContent>
          <D.DialogTitle>Start {freshening?.name}'s folders fresh?</D.DialogTitle>
          <D.DialogDescription>
            Its clones and what it installed or built in your place go. Its next run clones the
            repository again. Its memory and history stay in Agentome.
          </D.DialogDescription>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button variant="quiet">Cancel</Button>
            </D.DialogClose>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void act(`/api/me/place/folders/${freshening?.id ?? ''}`, 'DELETE').then(
                  (done) => done && setFreshening(null),
                )
              }
            >
              Start fresh
            </Button>
          </D.DialogFooter>
        </D.DialogContent>
      </D.Dialog>
      <D.Dialog open={deleting} onOpenChange={setDeleting}>
        <D.DialogContent>
          <D.DialogTitle>Delete your place on the server?</D.DialogTitle>
          <D.DialogDescription>
            Its sign-in to Claude Code and Codex and your agents' working folders go with it. A run
            in it is cancelled. Your agents, their memory and history stay in Agentome.
          </D.DialogDescription>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button variant="quiet">Cancel</Button>
            </D.DialogClose>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void act('/api/me/place', 'DELETE').then((done) => done && setDeleting(false))
              }
            >
              Delete place
            </Button>
          </D.DialogFooter>
        </D.DialogContent>
      </D.Dialog>
    </section>
  );
}
