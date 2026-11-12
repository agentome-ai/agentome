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
  const formRef = useFocusFirstError(errors);

  useEffect(() => {
    api<{ keycloak: boolean }>('/api/setup').then(
      (setup) => setKeycloak(setup.keycloak),
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
      await api('/api/auth/sign-in/email', { body: { email, password } });
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (caught) {
      const error = asApiError(caught);
      if (error.code === 'setup_required') return navigate('/setup', { replace: true });
      setFormError(signInErrors[error.code] ?? error.message);
      setPending(false);
    }
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
          <p className="my-5 flex items-center gap-3 text-small text-ink-3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
            or with a password
          </p>
        </>
      )}
      {/* Back from the page that set a new password, which signed the person out everywhere. */}
      {params.get('reset') === 'done' && (
        <p role="status" className="mb-5 text-ink-2">
          Your password is changed. Sign in with the new one.
        </p>
      )}
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
      <p className="mt-6 text-ink-2">
        {keycloak
          ? 'No account yet? Sign in with Keycloak: your first sign-in makes one.'
          : 'No account yet? Ask an admin for an invitation.'}
      </p>
      {/* No mail leaves the server, so the way back is a link from the person who runs it. */}
      <p className="mt-2 text-ink-3">
        Forgot your password? Whoever runs your Agentome can give you a link for a new one.
      </p>
    </AuthPage>
  );
}
