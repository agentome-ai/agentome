import qrcode from 'qrcode-generator';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { type ApiError, api, asApiError } from '../api';
import { useMe } from '../session';
import { Button } from '../ui/button';
import { Copyable } from '../ui/copyable';
import { Field, FormError, PasswordInput } from '../ui/field';
import { Input } from '../ui/input';
import { Panel, Row } from './panel';

// The second step of a password sign-in: a code from an authenticator app, through
// better-auth's two-factor routes. Turning it on, off, or making new backup codes asks for the
// password; it is on once the app's first code is right. Admins set it up before anything else
// (the page at /two-step); everyone else here, on their Account page.

const say = (error: ApiError) =>
  ({
    invalid_password: 'The password is wrong. Check it, then try again.',
    invalid_code: 'That code is wrong or has expired. Enter the one your app shows now.',
    rate_limited: 'Too many attempts. Wait 10 seconds, then try again.',
  })[error.code] ?? error.message;

/** The address an authenticator app reads, as a QR code: dark squares on light, as apps expect. */
function QrCode({ value }: { value: string }) {
  const cells = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(value);
    code.make();
    const size = code.getModuleCount();
    const dark: string[] = [];
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (code.isDark(row, col)) dark.push(`M${col} ${row}h1v1h-1z`);
      }
    }
    return { size, path: dark.join('') };
  }, [value]);
  return (
    // White in the dark theme too: some apps cannot read a code drawn light on dark.
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={`-2 -2 ${cells.size + 4} ${cells.size + 4}`}
      className="size-44 rounded-md bg-white text-black"
      shapeRendering="crispEdges"
    >
      <path d={cells.path} fill="currentColor" />
    </svg>
  );
}

/** The backup codes, shown once: each signs the person in once without the app. */
function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const list = useRef<HTMLUListElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      // No clipboard on plain http: the codes are selected, for ⌘C.
      if (list.current) window.getSelection()?.selectAllChildren(list.current);
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-ink-2">
        Keep these backup codes somewhere safe. Each one signs you in once if you lose your phone;
        they are not shown again.
      </p>
      <div className="flex items-start gap-3 rounded-lg bg-desk py-3 pr-2 pl-4">
        <ul
          ref={list}
          aria-label="Backup codes"
          className="grid flex-1 grid-cols-[repeat(2,max-content)] gap-x-10 gap-y-1.5 font-mono text-small max-sm:grid-cols-1"
        >
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <Button size="sm" className="shrink-0" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Turning the second step on: the password, then the app's QR code (or its key, typed in) and
 * its first code, then the backup codes. `onDone` comes after the person has seen the codes.
 */
export function TwoStepSetup(props: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [started, setStarted] = useState<{ uri: string; backupCodes: string[] }>();
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const key = started ? (new URL(started.uri).searchParams.get('secret') ?? '') : '';

  async function attempt(work: () => Promise<void>) {
    setPending(true);
    setError(undefined);
    try {
      await work();
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  function start(event: FormEvent) {
    event.preventDefault();
    if (pending || password === '') return;
    void attempt(async () => {
      const answer = await api<{ totpURI: string; backupCodes: string[] }>(
        '/api/auth/two-factor/enable',
        { body: { password } },
      );
      setPassword('');
      setStarted({ uri: answer.totpURI, backupCodes: answer.backupCodes });
    });
  }

  function confirm(event: FormEvent) {
    event.preventDefault();
    if (pending || code.trim().length < 6) return;
    void attempt(async () => {
      await api('/api/auth/two-factor/verify-totp', { body: { code: code.trim() } });
      setDone(true);
    });
  }

  if (done && started) {
    return (
      <div className="grid gap-5">
        <BackupCodes codes={started.backupCodes} />
        <Button variant="primary" className="justify-self-start" onClick={props.onDone}>
          Done
        </Button>
      </div>
    );
  }
  if (started) {
    return (
      <form onSubmit={confirm} noValidate className="grid gap-5">
        <div className="grid justify-items-start gap-3">
          <p className="text-ink-2">
            Scan this with your authenticator app, such as 1Password, Google Authenticator or
            Microsoft Authenticator. No camera? Enter the key instead.
          </p>
          <QrCode value={started.uri} />
          <div className="w-full">
            <Copyable label="Copy key" value={key} />
          </div>
        </div>
        <Field label="Code from the app" error={error ? say(error) : undefined}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          className="justify-self-start"
          disabled={pending || code.length < 6}
        >
          {pending ? 'Checking…' : 'Turn on'}
        </Button>
      </form>
    );
  }
  return (
    <form onSubmit={start} noValidate className="grid gap-5">
      <Field label="Your password" error={error ? say(error) : undefined}>
        {(control) => (
          <PasswordInput
            {...control}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="primary"
        className="justify-self-start"
        disabled={pending || password === ''}
      >
        {pending ? 'Checking…' : 'Continue'}
      </Button>
    </form>
  );
}

/** The Account page's panel: whether a sign-in asks for a code, and turning it on or off. */
export function TwoStepPanel() {
  const me = useMe();
  const [state, setState] = useState<{ available: boolean; enabled: boolean }>();
  const [mode, setMode] = useState<'idle' | 'setup' | 'off' | 'codes'>('idle');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  const load = () =>
    api<{ available: boolean; enabled: boolean }>('/api/me/two-factor').then(setState, () =>
      setState(undefined),
    );
  useEffect(() => void load(), []);

  // Keycloak alone signs this person in, with Keycloak's own second step.
  if (!state?.available) return null;

  function withPassword(event: FormEvent) {
    event.preventDefault();
    if (pending || password === '') return;
    setPending(true);
    setError(undefined);
    const off = mode === 'off';
    api<{ backupCodes?: string[] }>(
      off ? '/api/auth/two-factor/disable' : '/api/auth/two-factor/generate-backup-codes',
      { body: { password } },
    )
      .then(
        async (answer) => {
          setPassword('');
          if (off) {
            setMode('idle');
            await load();
          } else {
            setCodes(answer.backupCodes);
          }
        },
        (caught) => setError(asApiError(caught)),
      )
      .finally(() => setPending(false));
  }

  const status = state.enabled
    ? 'On. A password sign-in also asks for a code from your authenticator app.'
    : 'Off. Turn it on to ask for a code from your authenticator app after your password.';

  if (mode === 'setup') {
    return (
      <Panel title="Two-step sign-in">
        <div className="px-4 py-4 max-md:px-3.5">
          <TwoStepSetup
            onDone={() => {
              setMode('idle');
              void load();
            }}
          />
        </div>
      </Panel>
    );
  }
  if (mode === 'off' || mode === 'codes') {
    return (
      <form onSubmit={withPassword} noValidate>
        <Panel
          title="Two-step sign-in"
          footer={
            codes ? (
              <Button
                variant="primary"
                onClick={() => {
                  setCodes(undefined);
                  setMode('idle');
                }}
              >
                Done
              </Button>
            ) : (
              <>
                {error && <FormError>{say(error)}</FormError>}
                <Button variant="quiet" onClick={() => setMode('idle')}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={mode === 'off' ? 'danger' : 'primary'}
                  disabled={pending || password === ''}
                >
                  {mode === 'off' ? 'Turn off' : 'Make new codes'}
                </Button>
              </>
            )
          }
        >
          {codes ? (
            <div className="px-4 py-4 max-md:px-3.5">
              <BackupCodes codes={codes} />
            </div>
          ) : (
            <Row
              label="Your password"
              hint={
                mode === 'off'
                  ? 'Your password alone will sign you in again.'
                  : 'New codes replace the ones you have.'
              }
            >
              {(control) => (
                <PasswordInput
                  {...control}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Row>
          )}
        </Panel>
      </form>
    );
  }
  return (
    <Panel
      title="Two-step sign-in"
      footer={
        state.enabled ? (
          <>
            <Button onClick={() => setMode('codes')}>New backup codes</Button>
            {/* An admin keeps it: without it, they would be asked to set it up again at once. */}
            {me.role !== 'admin' && (
              <Button variant="danger" onClick={() => setMode('off')}>
                Turn off
              </Button>
            )}
          </>
        ) : (
          <Button variant="primary" onClick={() => setMode('setup')}>
            Turn on
          </Button>
        )
      }
    >
      <p className="px-4 py-3 text-ink-2 max-md:px-3.5">{status}</p>
    </Panel>
  );
}
