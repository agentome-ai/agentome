import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { Presence } from '../ui/status';
import { Switch } from '../ui/switch';
import { PlaceTerminal } from './place-terminal';

// A person's own place on the company's server: a container of theirs, made by the platform,
// that runs their agents under their subscription while they work in Agentome. Nothing to
// install on their computer. Shown above the computers when the installation has places.

type PlaceView = {
  available: boolean;
  /** Whether people's own computers may run agents here; off, agents run only on the server. */
  computers?: boolean;
  /** Whether an admin lets places here work while their people are away. */
  awayAllowed?: boolean;
  place: null | {
    seatId: string | null;
    state: 'none' | 'asleep' | 'awake' | 'unknown';
    signedOut: string[];
    lastSeenAt: string | null;
    /** Whether the person lets it take runs while they are away. */
    worksWhileAway?: boolean;
    agents: { id: string; name: string }[];
    /** On Docker, what its volumes hold and may hold; null where the launcher does not count. */
    disk?: { usedBytes: number; limitBytes: number } | null;
  };
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const STATE: Record<NonNullable<PlaceView['place']>['state'], string> = {
  awake: 'Awake',
  asleep: 'Asleep: it wakes when one of your agents has work and you are here',
  none: 'Being made',
  unknown: 'Agentome cannot reach the place launcher right now',
};

export function PlaceSection(props: { onComputers?: (on: boolean) => void; admin?: boolean }) {
  const { onComputers } = props;
  const [confirmingAway, setConfirmingAway] = useState(false);
  const [view, setView] = useState<PlaceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [freshening, setFreshening] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await api<PlaceView>('/api/me/place');
      setView(loaded);
      onComputers?.(loaded.computers ?? true);
    } catch {
      // A place is an extra: the computers below still load without it.
      setView({ available: false, place: null });
    }
  }, [onComputers]);
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

  const put = async (path: string, body: object) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api<PlaceView>(path, { method: 'PUT', body }));
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
  const allowed = view.awayAllowed ?? true;
  const away = allowed && (place?.worksWhileAway ?? false);
  const stateText =
    place?.state === 'asleep' && away
      ? 'Asleep: it wakes when one of your agents has work'
      : place && STATE[place.state];

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
            <Presence online={place.state === 'awake'}>{stateText}</Presence>
          </p>
          {place.disk && place.disk.usedBytes > place.disk.limitBytes && (
            <p role="alert" className="mt-3 max-w-[72ch] text-read text-failed">
              Your place holds {gb(place.disk.usedBytes)} of its {gb(place.disk.limitBytes)}, so it
              sleeps and takes no runs. Start an agent’s folders fresh below, then wake it.
            </p>
          )}
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
          <div className="mt-6 flex max-w-[72ch] items-start gap-3">
            <Switch
              id="place-away"
              className="mt-1.5"
              checked={away}
              disabled={busy || !allowed}
              aria-describedby="place-away-hint"
              onCheckedChange={(on) =>
                on ? setConfirmingAway(true) : void put('/api/me/place/away', { on: false })
              }
            />
            <div className="grid gap-0.5">
              <label htmlFor="place-away" className="text-read font-medium text-ink">
                Work while I'm away
              </label>
              <p id="place-away-hint" className="text-read text-ink-2">
                {!allowed
                  ? 'An admin has turned this off: your place takes runs only while you are here.'
                  : away
                    ? 'Your place takes your agents’ runs on your subscription when you are not in Agentome, at night too.'
                    : 'Your agents’ runs wait until you are back in Agentome.'}
              </p>
            </div>
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
      {props.admin && (
        <div className="mt-6 flex max-w-[72ch] items-start gap-3 border-t border-line pt-4">
          <Switch
            id="places-away"
            className="mt-1.5"
            checked={allowed}
            disabled={busy}
            aria-describedby="places-away-hint"
            onCheckedChange={(on) => void put('/api/admin/places/away', { allowed: on })}
          />
          <div className="grid gap-0.5">
            <label htmlFor="places-away" className="text-read font-medium text-ink">
              Let people's places work while they are away
            </label>
            <p id="places-away-hint" className="text-read text-ink-2">
              For everyone here. Each person still turns it on for their own place. Off, every place
              waits for its person.
            </p>
          </div>
        </div>
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
      <D.Dialog open={confirmingAway} onOpenChange={setConfirmingAway}>
        <D.DialogContent>
          <D.DialogTitle>Let your place work while you are away?</D.DialogTitle>
          <D.DialogDescription>
            Your agents will run on your own Claude or ChatGPT subscription when you are not in
            Agentome: at night, in a meeting, on a day off. Anthropic's and OpenAI's terms for
            personal plans may not allow use with nobody at it, and a limit or a block would fall on
            your account, not the company's. You can turn this off at any time.
          </D.DialogDescription>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button variant="quiet">Cancel</Button>
            </D.DialogClose>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void put('/api/me/place/away', { on: true }).then(
                  (done) => done && setConfirmingAway(false),
                )
              }
            >
              Work while I'm away
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
