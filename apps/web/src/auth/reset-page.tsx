import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, asApiError } from '../api';
import { Button } from '../ui/button';
import { Field, FormError, PasswordInput } from '../ui/field';
import { AuthPage, useFocusFirstError } from './auth-page';
import { passwordError } from './setup-page';

/**
 * /reset-password#<token>: a new password for someone who forgot theirs. The link comes from
 * whoever runs the server (`agentome reset-password`); it works once, for an hour, and the new
 * password signs the person out everywhere, so they sign in with it next. The token is after the
 * `#`, which the browser never sends: the server meets it only in the request that uses it.
 */
export function ResetPage() {
  // Kept from the first render: the address loses it below, and the form still needs it.
  const [token] = useState(useLocation().hash.slice(1));
  const navigate = useNavigate();
  // Out of the address bar and the tab's history once it is read.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string>();
  // A link without its token is as good as a used one.
  const [spent, setSpent] = useState(token === '');
  const [pending, setPending] = useState(false);
  const formRef = useFocusFirstError(errors);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    const invalid = {
      password: passwordError(password),
      confirm: String(form.get('confirm')) === password ? undefined : "The passwords don't match.",
    };
    setErrors(invalid);
    setFormError(undefined);
    if (invalid.password || invalid.confirm) return;
    setPending(true);
    try {
      await api('/api/auth/reset-password', { body: { token, newPassword: password } });
      navigate('/login?reset=done', { replace: true });
    } catch (caught) {
      const error = asApiError(caught);
      setPending(false);
      if (error.code === 'invalid_token') return setSpent(true);
      if (error.code === 'password_too_short' || error.code === 'password_too_long') {
        return setErrors({ password: 'Use from 12 to 128 characters.' });
      }
      setFormError(error.message);
    }
  }

  if (spent) {
    return (
      <AuthPage
        title="This link doesn't work any more"
        description="A link for a new password works once, for an hour. Ask whoever runs your Agentome for a new one."
      >
        <p>
          <Link to="/login" className="font-medium text-ink underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </AuthPage>
    );
  }
  return (
    <AuthPage
      title="Set a new password"
      description="It replaces the one you forgot, signs you out everywhere else and revokes your API tokens."
    >
      <form ref={formRef} noValidate onSubmit={submit} className="grid gap-4">
        <Field label="New password" hint="At least 12 characters." error={errors.password}>
          {(control) => <PasswordInput {...control} name="password" autoComplete="new-password" />}
        </Field>
        <Field label="Confirm password" error={errors.confirm}>
          {(control) => <PasswordInput {...control} name="confirm" autoComplete="new-password" />}
        </Field>
        {formError && <FormError>{formError}</FormError>}
        <Button type="submit" variant="primary" disabled={pending} className="mt-2 w-full">
          {pending ? 'Saving…' : 'Set the password'}
        </Button>
      </form>
    </AuthPage>
  );
}
