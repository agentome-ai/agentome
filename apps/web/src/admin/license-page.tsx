import { type FormEvent, useState } from 'react';
import { api, asApiError } from '../api';
import { frame, PageHeader } from '../shell/page-header';
import { LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { FormError } from '../ui/field';
import { Textarea } from '../ui/input';
import { Properties, Property } from '../ui/properties';
import { FREE_AGENTS, type License, licenseDay, overWords, useLicense } from './license-data';

// Admin → License: Free or whom Agentome is licensed to and until when, the
// agents, where the installation is over Free, the installation's ID a key can be made out to,
// and the field a key goes into. Visible to the company, so the term is never a surprise.

const stateWords: Record<License['status'], string> = {
  free: 'Free',
  valid: 'Active',
  grace: 'Ended: in its 14 days of grace',
  read_only: 'Read-only: over Free without a license key',
};

function Agents({ license }: { license: License }) {
  const { agents } = license;
  if (!license.enterprise) {
    return (
      <>
        {agents.active} active
        <span className="text-ink-3"> of {FREE_AGENTS} on Free</span>
      </>
    );
  }
  const over = agents.limit !== null && agents.peak > agents.limit;
  return (
    <>
      {agents.active} active
      {agents.limit !== null && (
        <span className="text-ink-3">
          {' '}
          of {agents.limit}; at most {agents.peak} so far
        </span>
      )}
      {over && (
        <span className="mt-0.5 block text-small text-waiting">
          Over the plan by {agents.peak - (agents.limit ?? 0)}. Nothing stops: the next license
          counts them.
        </span>
      )}
    </>
  );
}

export function LicensePage() {
  const { license, setLicense } = useLicense();
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [applied, setApplied] = useState(false);

  async function apply(event: FormEvent) {
    event.preventDefault();
    if (!key.trim() || pending) return;
    setPending(true);
    setError(undefined);
    setApplied(false);
    try {
      setLicense(await api<License>('/api/admin/license', { method: 'PUT', body: { key } }));
      setKey('');
      setApplied(true);
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader title="License" crumbs={[{ label: 'Admin', to: '/admin' }]} />
      <div className={cn(frame.read, 'grid gap-10 pt-8 pb-24')}>
        {!license ? (
          <LoadingState label="Loading the license" />
        ) : (
          <section aria-labelledby="license-terms" className="grid gap-4">
            <h2 id="license-terms" className="text-section">
              {license.company ? `Licensed to ${license.company}` : 'Free'}
            </h2>
            <Properties className="grid-cols-[140px_minmax(0,1fr)]">
              <Property label="State">
                <span
                  className={cn(
                    (license.status === 'valid' || license.status === 'free') && 'text-ink',
                    license.status === 'grace' && 'text-waiting',
                    license.status === 'read_only' && 'text-failed',
                  )}
                >
                  {stateWords[license.status]}
                </span>
              </Property>
              {license.expiresAt && (
                <Property label="Valid until">{licenseDay(license.expiresAt)}</Property>
              )}
              {license.graceEndsAt && (
                <Property label="Grace ends">{licenseDay(license.graceEndsAt)}</Property>
              )}
              <Property label="Agents">
                <Agents license={license} />
              </Property>
              {license.id && (
                <Property label="License ID">
                  <span className="font-mono text-small text-ink-2">{license.id}</span>
                </Property>
              )}
              <Property label="Installation ID">
                <span className="font-mono text-small text-ink-2 select-all">
                  {license.installationId}
                </span>
              </Property>
            </Properties>
            {license.status === 'read_only' && (
              <div className="grid gap-2 text-small">
                <p className="text-ink">Over Free here:</p>
                <ul className="grid list-disc gap-1 pl-5 text-ink-2">
                  {license.over.map((item) => (
                    <li key={item}>{overWords[item]}</li>
                  ))}
                </ul>
                <p className="max-w-170 text-ink-3">
                  Add a license key below, or cut back to Free: archive agents, remove teams, move
                  agents to their owners’ computers, take monthly budgets off. Agentome works again
                  at once.
                </p>
              </div>
            )}
            <p className="max-w-170 text-small text-ink-3">
              Without a key Agentome is Free, with no end: up to {FREE_AGENTS} active agents and one
              team, on people’s computers, without monthly budgets. A key adds Keycloak sign-in,
              agents on the server, monthly budgets and analytics. After its end it works 14 more
              days; then an installation over Free turns read-only. To get a key, send the
              installation ID to hello@agentome.ai.
            </p>
          </section>
        )}

        <form noValidate onSubmit={apply} className="grid gap-3" aria-labelledby="license-key">
          <h2 id="license-key" className="text-section">
            New license key
          </h2>
          <Textarea
            aria-label="License key"
            value={key}
            placeholder="agentome-license-v1.…"
            className="min-h-24 font-mono text-small break-all"
            onChange={(event) => {
              setKey(event.target.value);
              setApplied(false);
            }}
          />
          {error && <FormError>{error}</FormError>}
          {applied && <p className="text-small text-done">The new key is in. It works at once.</p>}
          <div>
            <Button type="submit" variant="primary" disabled={pending || !key.trim()}>
              {pending ? 'Applying…' : 'Apply key'}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
