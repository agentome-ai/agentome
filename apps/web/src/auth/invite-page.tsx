import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { type ApiError, api, asApiError, fieldErrors, type Role } from '../api';
import { Button } from '../ui/button';
import { Field, FormError, PasswordInput } from '../ui/field';
import { Input } from '../ui/input';
import { AuthPage, looksLikeEmail, useFocusFirstError } from './auth-page';
import { passwordError } from './setup-page';

type Reason = 'unknown' | 'expired' | 'revoked' | 'accepted';
type Invitation = {
  role: Role;
  email: string | null;
  /** Absent from a server before the invitation named who sent it. */
  invitedBy?: string;
  orgName?: string;
};
type Lookup = ({ valid: true } & Invitation) | { valid: false; reason: Reason };

const unavailable: Record<Reason, { title: string; text: string }> = {
  unknown: {
    title: "This invitation link doesn't work",
    text: 'Check that you copied the whole link, or ask an admin for a new one.',
  },
  expired: {
    title: 'This invitation has expired',
    text: 'Ask the admin who invited you for a new link.',
  },
  revoked: {
    title: 'This invitation was revoked',
    text: 'Ask the admin who invited you for a new link.',
  },
  accepted: {
    title: 'This invitation was already used',
    text: 'Sign in with the account it created.',
  },
};

const signInLink = (
  <Link to="/login" className="font-medium text-ink underline underline-offset-2">
    Sign in
  </Link>
);

export function InvitePage() {
  const { token = '' } = useParams();
  const [lookup, setLookup] = useState<Lookup>();
  const [loadError, setLoadError] = useState<ApiError>();

  const load = useCallback(() => {
    setLoadError(undefined);
    api<Lookup>(`/api/invitations/${encodeURIComponent(token)}`).then(setLookup, (error) =>
      setLoadError(asApiError(error)),
    );
  }, [token]);
  useEffect(load, [load]);

  if (loadError) {
    return (
      <AuthPage title="Couldn't check the invitation" description={loadError.message}>
        <Button onClick={load}>Retry</Button>
      </AuthPage>
    );
  }
  if (!lookup) {
    return (
      <AuthPage title="Join Agentome">
        <p role="status" className="text-ink-2">
          Checking the invitation…
        </p>
      </AuthPage>
    );
  }
  if (!lookup.valid) {
    const { title, text } = unavailable[lookup.reason];
    return (
      <AuthPage title={title} description={text}>
        {lookup.reason === 'accepted' && <p>{signInLink}</p>}
      </AuthPage>
    );
  }
  return <AcceptForm token={token} invitation={lookup} onUnavailable={setLookup} />;
}

function AcceptForm(props: {
  token: string;
  invitation: Invitation;
  onUnavailable: (lookup: Lookup) => void;
}) {
  const navigate = useNavigate();
  const [errors, setErrors] = useState<Partial<Record<'name' | 'email' | 'password', string>>>({});
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const formRef = useFocusFirstError(errors);
  const boundEmail = props.invitation.email;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get('name')).trim(),
      email: boundEmail ?? String(form.get('email')).trim(),
      password: String(form.get('password')),
    };
    const invalid = {
      name: body.name ? undefined : 'Enter your name.',
      email: looksLikeEmail(body.email)
        ? undefined
        : 'Enter an email address like ann@example.com.',
      password: passwordError(body.password),
    };
    setErrors(invalid);
    setFormError(undefined);
    if (Object.values(invalid).some(Boolean)) return;
    setPending(true);
    try {
      await api(`/api/invitations/${encodeURIComponent(props.token)}/accept`, { body });
      navigate('/', { replace: true });
    } catch (caught) {
      const error = asApiError(caught);
      setPending(false);
      const reason = (error.details as { reason?: Reason } | undefined)?.reason;
      // Used, revoked or expired while the form was open.
      if (error.code === 'invitation_invalid' && reason) {
        return props.onUnavailable({ valid: false, reason });
      }
      if (error.code === 'email_taken') return setErrors({ email: error.message });
      setErrors(fieldErrors(error));
      if (error.code !== 'validation_failed') setFormError(error.message);
    }
  }

  return (
    <AuthPage title="Join Agentome" description={inviteSentence(props.invitation)}>
      <form ref={formRef} noValidate onSubmit={submit} className="grid gap-4">
        <Field label="Your name" error={errors.name}>
          {(control) => <Input {...control} name="name" autoComplete="name" />}
        </Field>
        <Field
          label="Email"
          hint={boundEmail ? 'The invitation is for this address.' : undefined}
          error={errors.email}
        >
          {(control) => (
            <Input
              {...control}
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={boundEmail ?? undefined}
              readOnly={boundEmail !== null}
            />
          )}
        </Field>
        <Field label="Password" hint="At least 12 characters." error={errors.password}>
          {(control) => <PasswordInput {...control} name="password" autoComplete="new-password" />}
        </Field>
        {formError && <FormError>{formError}</FormError>}
        <Button type="submit" variant="primary" disabled={pending} className="mt-2 w-full">
          {pending ? 'Creating the account…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-6 text-ink-2">Already have an account? {signInLink}</p>
    </AuthPage>
  );
}

/** "Ann Admin invited you to join Acme as a member.": who asks, to where, as what. */
function inviteSentence({ role, invitedBy, orgName }: Invitation): string {
  const as = role === 'admin' ? 'an admin' : 'a member';
  if (invitedBy && orgName) return `${invitedBy} invited you to join ${orgName} as ${as}.`;
  return `You're invited as ${as}.`;
}
