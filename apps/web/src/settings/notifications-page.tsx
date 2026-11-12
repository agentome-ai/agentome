import { BellRing } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api, asApiError } from '../api';
import { pushState, turnOff, turnOn, type PushState } from '../shell/push';
import { frame, PageHeader } from '../shell/page-header';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { FormError } from '../ui/field';
import { Switch } from '../ui/switch';
import { Panel } from './panel';

// Notifications on this device: turned on per browser, so the page speaks of this
// device, and says plainly what stands in the way when it cannot be done here. A page of its
// own: a switch for this device, a test once it is on.

const BLOCKED: Partial<Record<PushState, string>> = {
  insecure:
    "This address isn't HTTPS, so the browser won't deliver notifications. An administrator can turn on HTTPS for Agentome.",
  install:
    'On iPhone and iPad, notifications go to the installed app. In Safari, tap Share, then Add to Home Screen, open Agentome from the Home Screen and turn them on there.',
  unsupported: "This browser can't receive notifications.",
  denied:
    'Notifications are blocked for Agentome in this browser. Allow them in its site settings, then open this page again.',
};

export function NotificationsPage() {
  const [state, setState] = useState<PushState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const id = useId();

  useEffect(() => {
    pushState().then(setState, (caught) => setError(asApiError(caught).message));
  }, []);

  async function act(step: () => Promise<PushState | void>) {
    setPending(true);
    setError(undefined);
    setNote(undefined);
    try {
      const next = await step();
      if (next) setState(next);
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  async function test() {
    const { sent } = await api<{ sent: number }>('/api/me/push/test', { body: {} });
    setNote(
      sent === 0
        ? 'No device took it. Turn notifications off and on again here.'
        : `Sent to ${sent === 1 ? 'this device' : `${sent} devices`}.`,
    );
  }

  const blocked = state && BLOCKED[state];
  const settable = state === 'on' || state === 'off';
  return (
    <>
      <PageHeader title="Notifications" titleIn="bar" phoneBack={{ label: 'More', to: '/more' }} />
      <div className={cn('grid gap-8 pt-8 pb-24 max-md:gap-5.5 max-md:pt-3', frame.read)}>
        <Panel
          title="This device"
          footer={
            state === 'on' ? (
              <>
                {note && (
                  <p role="status" className="text-ink-2">
                    {note}
                  </p>
                )}
                <Button disabled={pending} onClick={() => void act(test)}>
                  Send a test
                </Button>
              </>
            ) : undefined
          }
        >
          <div className="flex items-center gap-4 px-4 py-3 max-md:px-3.5">
            <BellRing aria-hidden="true" className="size-4.5 shrink-0 text-ink-2" />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <label htmlFor={id} className="font-medium">
                Push notifications
              </label>
              <p id={`${id}-note`} className="text-small text-ink-3">
                When an approval waits on your agent, and when a run you started finishes or fails.
              </p>
            </div>
            <Switch
              id={id}
              aria-describedby={`${id}-note`}
              checked={state === 'on'}
              disabled={!settable || pending}
              onCheckedChange={(on) => void act(on ? turnOn : turnOff)}
            />
          </div>
          {(state === undefined || blocked || error) && (
            <div className="px-4 py-3 max-md:px-3.5" aria-live="polite">
              {state === undefined && !error && <p className="text-ink-2">Checking this device…</p>}
              {blocked && <p className="text-ink-2">{blocked}</p>}
              {error && <FormError>{error}</FormError>}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
