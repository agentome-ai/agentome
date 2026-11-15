import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, asApiError } from '../api';
import { Button } from '../ui/button';
import { Field, FormError, PasswordInput } from '../ui/field';
import { Input } from '../ui/input';
import { AuthPage, looksLikeEmail, useFocusFirstError } from './auth-page';

// better-auth's messages are terse; these say what to do next.
const signInErrors: Record<string, string> = {
  invalid_email_or_password: 'The email or password is wrong. Check both, then try again.',
  rate_limited: 'Too many attempts. Wait 10 seconds, then try again.',
};

// The second step's: a wrong code, a sign-in that waited too long, too many wrong codes.
const codeErrors: Record<string, string> = {
  invalid_code: 'That code is wrong or has expired. Enter the one your app shows now.',
  invalid_backup_code: 'That backup code is wrong or was used already.',
  rate_limited: 'Too many attempts. Wait 10 seconds, then try again.',
  account_temporarily_locked: 'Too many wrong codes. Wait 15 minutes, then sign in again.',
};
// After these the sign-in itself is over, and the password comes first again.
const signInAgain: Record<string, string> = {
  invalid_two_factor_cookie: 'This sign-in waited too long. Sign in again.',
  too_many_attempts_request_new_code: 'Too many wrong codes for this sign-in. Sign in again.',
};

// What Keycloak's sign-in comes back with, in ?error=.
const keycloakErrors: Record<string, string> = {
  account_disabled: 'This account is disabled. Ask an admin to enable it.',
  access_denied: 'Keycloak did not let you in. Ask your Keycloak admin for access.',
  account_not_linked:
    'An account with your email exists, but its address was never confirmed. Sign in with your password, or ask an admin.',
};
const keycloakError = (code: string) =>
  keycloakErrors[code.toLowerCase()] ??
  `Signing in with Keycloak didn't work (${code}). Try again, or sign in with your password.`;

// Only a path on this site: an address from the query string must not send anyone away.
const safeNext = (next: string | null) =>
  next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const returned = params.get('error');
  const [formError, setFormError] = useState(returned ? keycloakError(returned) : undefined);
  const [pending, setPending] = useState(false);
  const [keycloak, setKeycloak] = useState(false);
  // Off, the company signs everyone in through Keycloak, with its second factor.
  const [password, setPassword] = useState(true);
  // The password was right and the person turned the second step on: a code comes next.
  const [challenge, setChallenge] = useState(false);
  const [backup, setBackup] = useState(false);
  const [codeError, setCodeError] = useState<string>();
  const formRef = useFocusFirstError(errors);

  useEffect(() => {
    api<{ keycloak: boolean; password?: boolean }>('/api/setup').then(
      (setup) => {
        setKeycloak(setup.keycloak);
        setPassword(setup.password !== false);
      },
      () => setKeycloak(false),
    );
  }, []);

  // better-auth answers the address of Keycloak's sign-in, and Keycloak sends the browser back
  // through the server to where the person was going.
  async function withKeycloak() {
    setPending(true);
    setFormError(undefined);
    try {
      const { url } = await api<{ url: string }>('/api/auth/sign-in/social', {
        body: {
          provider: 'keycloak',
          callbackURL: safeNext(params.get('next')),
          errorCallbackURL: '/login',
        },
      });
      window.location.assign(url);
    } catch (caught) {
      setFormError(asApiError(caught).message);
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim();
    const password = String(form.get('password'));
    const invalid = {
      email: looksLikeEmail(email) ? undefined : 'Enter an email address like ann@example.com.',
      password: password ? undefined : 'Enter your password.',
    };
    setErrors(invalid);
    setFormError(undefined);
    if (invalid.email || invalid.password) return;
    setPending(true);
    try {
      const answer = await api<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', {
        body: { email, password },
      });
      if (answer.twoFactorRedirect) {
        setChallenge(true);
        setPending(false);
        return;
      }
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (caught) {
      const error = asApiError(caught);
      if (error.code === 'setup_required') return navigate('/setup', { replace: true });
      setFormError(signInErrors[error.code] ?? error.message);
      setPending(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code')).trim();
    if (!code) return setCodeError(backup ? 'Enter a backup code.' : 'Enter the code.');
    setPending(true);
    setCodeError(undefined);
    try {
      await api(
        backup ? '/api/auth/two-factor/verify-backup-code' : '/api/auth/two-factor/verify-totp',
        { body: { code } },
      );
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (caught) {
      const error = asApiError(caught);
      const over = signInAgain[error.code];
      if (over) {
        setChallenge(false);
        setFormError(over);
      } else {
        setCodeError(codeErrors[error.code] ?? error.message);
      }
      setPending(false);
    }
  }

  if (challenge) {
    return (
      <AuthPage
        title="Enter your code"
        description={
          backup
            ? 'Enter one of the backup codes you saved. Each works once.'
            : 'Open your authenticator app and enter the code it shows for Agentome.'
        }
      >
        <form noValidate onSubmit={submitCode} className="grid gap-4">
          <Field label={backup ? 'Backup code' : 'Code'} error={codeError}>
            {(control) => (
              <Input
                {...control}
                key={backup ? 'backup' : 'app'}
                name="code"
                autoFocus
                autoComplete="one-time-code"
                inputMode={backup ? 'text' : 'numeric'}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={pending} className="mt-2 w-full">
            {pending ? 'Checking…' : 'Sign in'}
          </Button>
        </form>
        <div className="mt-6 flex flex-wrap justify-between gap-2">
          <Button
            variant="quiet"
            onClick={() => {
              setBackup(!backup);
              setCodeError(undefined);
            }}
          >
            {backup ? 'Use the app instead' : 'Use a backup code'}
          </Button>
          <Button variant="quiet" onClick={() => setChallenge(false)}>
            Back
          </Button>
        </div>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Sign in to Agentome">
      {keycloak && (
        <>
          <Button
            type="button"
            className="w-full"
            disabled={pending}
            onClick={() => void withKeycloak()}
          >
            Sign in with Keycloak
          </Button>
          {password && (
            <p className="my-5 flex items-center gap-3 text-small text-ink-3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
              or with a password
            </p>
          )}
        </>
      )}
      {!password && !keycloak && (
        <p role="status" className="text-ink-2">
          This Agentome signs people in through Keycloak only, and its license does not cover
          Keycloak now. Whoever runs it can turn password sign-in back on.
        </p>
      )}
      {!password && formError && (
        <div className="mt-4">
          <FormError>{formError}</FormError>
        </div>
      )}
      {/* Back from the page that set a new password, which signed the person out everywhere. */}
      {params.get('reset') === 'done' && (
        <p role="status" className="mb-5 text-ink-2">
          Your password is changed. Sign in with the new one.
        </p>
      )}
      {password && (
        <form ref={formRef} noValidate onSubmit={submit} className="grid gap-4">
          <Field label="Email" error={errors.email}>
            {(control) => <Input {...control} name="email" type="email" autoComplete="email" />}
          </Field>
          <Field label="Password" error={errors.password}>
            {(control) => (
              <PasswordInput {...control} name="password" autoComplete="current-password" />
            )}
          </Field>
          {formError && <FormError>{formError}</FormError>}
          <Button type="submit" variant="primary" disabled={pending} className="mt-2 w-full">
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      )}
      <p className="mt-6 text-ink-2">
        {keycloak
          ? 'No account yet? Sign in with Keycloak: your first sign-in makes one.'
          : 'No account yet? Ask an admin for an invitation.'}
      </p>
      {/* No mail leaves the server, so the way back is a link from the person who runs it. */}
      {password && (
        <p className="mt-2 text-ink-3">
          Forgot your password? Whoever runs your Agentome can give you a link for a new one.
        </p>
      )}
    </AuthPage>
  );
}
