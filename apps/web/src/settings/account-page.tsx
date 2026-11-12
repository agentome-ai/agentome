import { type FormEvent, useState } from 'react';
import { useOutletContext } from 'react-router';
import { type ApiError, api, asApiError, fieldErrors } from '../api';
import { useMe } from '../session';
import type { MoreContext } from '../shell/more-page';
import { frame, PageHeader } from '../shell/page-header';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { FormError } from '../ui/field';
import { Input } from '../ui/input';
import { Panel, Row } from './panel';

// The person's own account: their name, the email they sign in with, and their password. A
// new email and a new password both ask for the current password (PATCH /api/me and
// better-auth's change-password); a new password signs the person's other devices out. A page
// of its own, in panels as Linear's settings, where it was a dialog.

const wrongPassword = 'The current password is wrong. Check it, then try again.';
const say = (error: ApiError) =>
  error.code === 'invalid_password' ? wrongPassword : error.message;

export function AccountPage() {
  const me = useMe();
  const { onAccountSaved } = useOutletContext<MoreContext>();
  return (
    <>
      <PageHeader title="Account" titleIn="bar" phoneBack={{ label: 'More', to: '/more' }} />
      <div className={cn('grid gap-8 pt-8 pb-24 max-md:gap-5.5 max-md:pt-3', frame.read)}>
        <Profile name={me.name} email={me.email} onSaved={() => onAccountSaved?.()} />
        <Password />
      </div>
    </>
  );
}

function Profile(props: { name: string; email: string; onSaved: () => void }) {
  const [name, setName] = useState(props.name);
  const [email, setEmail] = useState(props.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [saved, setSaved] = useState(false);
  const newEmail = email.trim().toLowerCase() !== props.email.toLowerCase();
  const changed = name.trim() !== props.name || newEmail;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending || !changed) return;
    setPending(true);
    setError(undefined);
    try {
      await api('/api/me', {
        method: 'PATCH',
        body: {
          name: name.trim(),
          ...(newEmail && { email: email.trim(), currentPassword }),
        },
      });
      setCurrentPassword('');
      setSaved(true);
      props.onSaved();
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  const fields = error ? fieldErrors(error) : {};
  return (
    <form onSubmit={(event) => void save(event)} noValidate>
      <Panel
        title="Profile"
        footer={
          <>
            {error && Object.keys(fields).length === 0 && <FormError>{say(error)}</FormError>}
            {saved && (
              <p role="status" className="text-ink-2">
                Saved.
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={pending || !changed || (newEmail && currentPassword === '')}
            >
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          </>
        }
      >
        <Row label="Name" hint="How people and agents see you." error={fields.name}>
          {(control) => (
            <Input
              {...control}
              autoComplete="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
          )}
        </Row>
        <Row label="Email" hint="You sign in with it." error={fields.email}>
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setSaved(false);
              }}
            />
          )}
        </Row>
        {newEmail && (
          <Row label="Current password" hint="Needed to change the email you sign in with.">
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            )}
          </Row>
        )}
      </Panel>
    </form>
  );
}

function Password() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [changed, setChanged] = useState(false);

  async function change(event: FormEvent) {
    event.preventDefault();
    if (pending || currentPassword === '' || newPassword.length < 12) return;
    setPending(true);
    setError(undefined);
    setChanged(false);
    try {
      await api('/api/auth/change-password', {
        body: { currentPassword, newPassword, revokeOtherSessions: true },
      });
      setCurrentPassword('');
      setNewPassword('');
      setChanged(true);
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void change(event)} noValidate>
      <Panel
        title="Password"
        footer={
          <>
            {error && <FormError>{say(error)}</FormError>}
            {changed && (
              <p role="status" className="text-ink-2">
                Password changed. Your other devices are signed out.
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={pending || currentPassword === '' || newPassword.length < 12}
            >
              {pending ? 'Changing…' : 'Change password'}
            </Button>
          </>
        }
      >
        <Row label="Current password">
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          )}
        </Row>
        <Row label="New password" hint="At least 12 characters. Your other devices are signed out.">
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          )}
        </Row>
      </Panel>
    </form>
  );
}
