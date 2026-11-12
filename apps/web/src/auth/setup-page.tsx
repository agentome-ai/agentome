import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api, asApiError, fieldErrors } from '../api';
import { Button } from '../ui/button';
import { Field, FormError, PasswordInput } from '../ui/field';
import { Input } from '../ui/input';
import { AuthPage, looksLikeEmail, useFocusFirstError } from './auth-page';

type Errors = Partial<
  Record<'code' | 'orgName' | 'name' | 'email' | 'password' | 'confirm', string>
>;

/** Also used by the invitation page: the rule the server applies to every password. */
export const passwordError = (password: string) =>
  password.length < 12 ? 'Use at least 12 characters.' : undefined;

export function SetupPage() {
  const navigate = useNavigate();
  const [completed, setCompleted] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const formRef = useFocusFirstError(errors);

  // The form shows at once; an installation that is already set up goes on to the app.
  // If the check fails, submitting the form tells why.
  useEffect(() => {
    api<{ completed: boolean }>('/api/setup').then(
      (setup) => setCompleted(setup.completed),
      () => setCompleted(false),
    );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key));
    const admin = {
      name: value('name').trim(),
      email: value('email').trim(),
      password: value('password'),
    };
    const invalid: Errors = {
      code: value('code').trim() ? undefined : 'Enter the setup code.',
      orgName: value('orgName').trim() ? undefined : 'Enter the name of your company.',
      name: admin.name ? undefined : 'Enter your name.',
      email: looksLikeEmail(admin.email)
        ? undefined
        : 'Enter an email address like ann@example.com.',
      password: passwordError(admin.password),
      confirm: value('confirm') === admin.password ? undefined : "The passwords don't match.",
    };
    setErrors(invalid);
    setFormError(undefined);
    if (Object.values(invalid).some(Boolean)) return;
    setPending(true);
    try {
      await api('/api/setup', {
        body: { code: value('code').trim(), orgName: value('orgName').trim(), admin },
      });
      navigate('/', { replace: true });
    } catch (caught) {
      const error = asApiError(caught);
      if (error.code === 'setup_completed') return navigate('/login', { replace: true });
      setErrors(fieldErrors(error));
      if (error.code !== 'validation_failed') setFormError(error.message);
      setPending(false);
    }
  }

  // The app's root sends a person who is not signed in on to sign-in, and keeps one who is.
  if (completed) return <Navigate to="/" replace />;
  return (
    <AuthPage
      title="Set up Agentome"
      description="Name your company and create the first administrator account. You'll invite everyone else after this."
    >
      <form ref={formRef} noValidate onSubmit={submit} className="grid gap-8">
        {/* Whoever reaches the server first must not become its admin: the code is in its log. */}
        <Field
          label="Setup code"
          hint="The installer printed it. It is also in the server's log: docker compose logs app."
          error={errors.code}
        >
          {(control) => <Input {...control} name="code" autoComplete="off" spellCheck={false} />}
        </Field>
        {/* One field needs no heading of its own: "Company" over "Company name" says it twice. */}
        <Field label="Company name" error={errors.orgName}>
          {(control) => <Input {...control} name="orgName" autoComplete="organization" />}
        </Field>
        <fieldset className="grid gap-4">
          <legend className="mb-4 text-section">Administrator</legend>
          <Field label="Your name" error={errors.name}>
            {(control) => <Input {...control} name="name" autoComplete="name" />}
          </Field>
          <Field label="Email" error={errors.email}>
            {(control) => <Input {...control} name="email" type="email" autoComplete="email" />}
          </Field>
          <Field label="Password" hint="At least 12 characters." error={errors.password}>
            {(control) => (
              <PasswordInput {...control} name="password" autoComplete="new-password" />
            )}
          </Field>
          <Field label="Confirm password" error={errors.confirm}>
            {(control) => <PasswordInput {...control} name="confirm" autoComplete="new-password" />}
          </Field>
        </fieldset>
        <div className="grid gap-4">
          {formError && <FormError>{formError}</FormError>}
          <Button type="submit" variant="primary" disabled={pending} className="w-full">
            {pending ? 'Creating the account…' : 'Create the administrator account'}
          </Button>
        </div>
      </form>
    </AuthPage>
  );
}
