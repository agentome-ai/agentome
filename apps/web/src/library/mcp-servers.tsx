import { useState } from 'react';
import { api, asApiError, fieldErrors, timeAgo } from '../api';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { canDelete, DeleteConfirm } from './delete-confirm';
import { ContextFacts } from '../shell/page-header';
import { MoreMenu, Pane, PaneHeader, UsedBy } from './pane';
import type { McpServer } from './skills-data';

// The library's MCP servers: remote servers whose tools
// the gateway passes to agents, with the server's secret kept on Agentome.

const tools = (count: number) => `${count} ${count === 1 ? 'tool' : 'tools'}`;

/** Opens the server's sign-in in this tab; the browser comes back to the library. */
async function signIn(serverId: string) {
  const { url } = await api<{ url: string }>(`/api/library/mcp/${serverId}/sign-in`, {
    method: 'POST',
  });
  window.location.assign(url);
}

/** What the list says under a server's name: whether it can be used, and how much it brings. */
export function serverNote(server: McpServer): string {
  if (server.auth === 'oauth' && !server.signedIn) return 'Not signed in';
  return tools(server.tools.length);
}

/**
 * One server, whole: where it is, how it signs in, the tools it listed. Its author edits it;
 * Check again, Sign out, Share for an admin and Delete are in the menu.
 */
export function ServerPane(props: {
  server: McpServer;
  me: { id: string; role: string };
  /** Said once after the browser came back from this server's sign-in. */
  signedIn?: boolean;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const { server, me } = props;
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mine = server.owner?.id === me.id;
  const oauth = server.auth === 'oauth';

  async function act(action: 'check' | 'share' | 'sign-in' | 'sign-out') {
    setPending(action);
    setError(undefined);
    try {
      if (action === 'sign-in') return await signIn(server.id);
      if (action === 'sign-out') {
        await api(`/api/library/mcp/${server.id}/sign-in`, { method: 'DELETE' });
      } else await api(`/api/library/mcp/${server.id}/${action}`, { method: 'POST' });
      await props.onChanged();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(undefined);
    }
  }

  return (
    <Pane
      label={server.name}
      onBack={props.onBack}
      context={
        <>
          <ContextFacts
            facts={[
              ['Added by', mine ? 'You' : (server.owner?.name ?? 'Agentome')],
              ['Shared with', server.visibility === 'org' ? 'Everyone' : 'Only its author'],
            ]}
          />
          <UsedBy url={`/api/library/mcp/${server.id}/agents`} from="its Tools &amp; policies" />
        </>
      }
      header={
        <PaneHeader
          title={server.name}
          about={server.description || undefined}
          note={
            server.visibility === 'org'
              ? 'Everyone can give it to their agents.'
              : 'Only its author can use it until an admin shares it.'
          }
          actions={
            <>
              {oauth && !server.signedIn && (
                <Button
                  variant="primary"
                  disabled={pending !== undefined}
                  onClick={() => void act('sign-in')}
                >
                  {pending === 'sign-in' ? 'Opening…' : 'Sign in'}
                </Button>
              )}
              {mine && <Button onClick={() => setEditing(true)}>Edit</Button>}
              <MoreMenu
                name={server.name}
                items={[
                  (!oauth || server.signedIn) && {
                    label: 'Check again',
                    onSelect: () => void act('check'),
                  },
                  oauth &&
                    server.signedIn && { label: 'Sign out', onSelect: () => void act('sign-out') },
                  me.role === 'admin' &&
                    server.visibility === 'private' && {
                      label: 'Share with everyone',
                      onSelect: () => void act('share'),
                    },
                  canDelete(server, me) && {
                    label: 'Delete',
                    danger: true,
                    onSelect: () => setDeleting(true),
                  },
                ]}
              />
            </>
          }
        />
      }
    >
      {props.signedIn && (
        <p role="status" className="text-ink-2">
          Signed in to {server.name}. Your agents that have it can use its tools.
        </p>
      )}
      {pending === 'check' && (
        <p role="status" className="text-ink-2">
          Checking…
        </p>
      )}
      {error && <FormError>{error}</FormError>}
      <dl className="overflow-hidden rounded-lg border border-line">
        {(
          [
            ['Address', <span className="font-mono text-[12.5px] break-all">{server.url}</span>],
            [
              'Sign-in',
              oauth
                ? server.signedIn
                  ? 'OAuth. You are signed in; your agents use your account.'
                  : 'OAuth. You are not signed in, so your agents cannot use it yet.'
                : server.hasAuthorization
                  ? 'A token, kept on Agentome, never shown'
                  : 'None',
            ],
            ['Checked', timeAgo(server.checkedAt)],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3 border-line px-3 py-2 not-first:border-t"
          >
            <dt className="text-ink-3">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="server-tools" className="grid gap-2">
        <h3 id="server-tools" className="text-section">
          {oauth && server.tools.length === 0 ? 'Tools' : tools(server.tools.length)}
        </h3>
        {server.tools.length === 0 ? (
          <p className="text-ink-3">
            {oauth ? 'Listed after you sign in.' : 'The server listed none at its last check.'}
          </p>
        ) : (
          <ul aria-label="Tools" className="overflow-hidden rounded-lg border border-line">
            {server.tools.map((tool) => (
              <li key={tool.name} className="border-line px-3 py-2 not-first:border-t">
                <span className="block">{tool.title}</span>
                <code className="text-small text-ink-3">{tool.name}</code>
                {tool.description && (
                  <span className="block text-small text-ink-2">{tool.description}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {editing && (
        <EditServerDialog
          server={server}
          onClose={() => setEditing(false)}
          onSaved={props.onChanged}
        />
      )}
      <D.Dialog open={deleting} onOpenChange={setDeleting}>
        <D.DialogContent>
          <DeleteConfirm
            kind="server"
            name={server.name}
            url={`/api/library/mcp/${server.id}`}
            onCancel={() => setDeleting(false)}
            onDeleted={props.onDeleted}
          />
        </D.DialogContent>
      </D.Dialog>
    </Pane>
  );
}

/**
 * The author's changes to a server: where it is, what it does, its token. Its name stays, since
 * agents' tools carry it. A server with a token is checked again before the change is kept.
 */
function EditServerDialog(props: {
  server: McpServer;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { server } = props;
  const oauth = server.auth === 'oauth';
  const [form, setForm] = useState({
    url: server.url,
    description: server.description,
    authorization: '',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setErrors({});
    try {
      await api(`/api/library/mcp/${server.id}`, {
        method: 'PATCH',
        body: {
          url: form.url.trim(),
          description: form.description,
          // An empty field keeps the token the server has.
          authorization: oauth ? undefined : authorizationOf(form.authorization),
        },
      });
      await props.onSaved();
      props.onClose();
    } catch (caught) {
      const failed = asApiError(caught);
      const byField = fieldErrors(failed);
      if (Object.keys(form).some((key) => byField[key])) setErrors(byField);
      else setError(failed.message);
    } finally {
      setPending(false);
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value }),
  });
  return (
    <D.Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <D.DialogContent>
        <form onSubmit={(event) => void save(event)} noValidate>
          <D.DialogTitle>
            Edit <code>{server.name}</code>
          </D.DialogTitle>
          <D.DialogDescription>
            Its name stays: agents know its tools by it. The change applies from the next run.
          </D.DialogDescription>
          <div className="grid gap-4 py-4">
            <Field
              label="Address"
              hint={
                oauth
                  ? 'A new address signs everyone out of this server: each person signs in again.'
                  : undefined
              }
              error={errors.url}
            >
              {(control) => <Input {...control} className="font-mono" {...field('url')} />}
            </Field>
            {!oauth && (
              <Field
                label="Token"
                hint={
                  server.hasAuthorization
                    ? 'Leave it empty to keep the token the server has. A new one replaces it.'
                    : 'Optional. Agentome sends it as Authorization: Bearer and the token.'
                }
                error={errors.authorization}
              >
                {(control) => (
                  <Input
                    {...control}
                    type="password"
                    autoComplete="off"
                    className="font-mono"
                    {...field('authorization')}
                  />
                )}
              </Field>
            )}
            <Field label="What it does" error={errors.description}>
              {(control) => <Input {...control} {...field('description')} />}
            </Field>
            {error && <FormError>{error}</FormError>}
          </div>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </D.DialogClose>
            <Button type="submit" variant="primary" disabled={pending || !form.url.trim()}>
              {pending ? (oauth ? 'Saving…' : 'Checking…') : 'Save'}
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}

/** The header from the token field: Bearer before a bare token, a whole header as it is. */
export function authorizationOf(value: string): string | undefined {
  const token = value.trim();
  if (!token) return undefined;
  return /^(bearer|basic|token)\s/i.test(token) ? token : `Bearer ${token}`;
}

/**
 * A remote server: Agentome connects to it once before saving, to list its tools. One that
 * signs in with OAuth is saved first, then the person signs in and the sign-in lists them.
 */
export function AddServerDialog(props: {
  onClose: () => void;
  onAdded: (id: string) => Promise<void>;
}) {
  const [form, setForm] = useState({ name: '', url: '', authorization: '', description: '' });
  const [auth, setAuth] = useState<'header' | 'oauth'>('header');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // The server's word on a field goes under that field: "The request is not valid" alone left
  // the person guessing which one.
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setErrors({});
    try {
      const added = await api<McpServer>('/api/library/mcp', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          url: form.url.trim(),
          description: form.description,
          auth,
          authorization: auth === 'header' ? authorizationOf(form.authorization) : undefined,
        },
      });
      if (auth === 'oauth') return await signIn(added.id);
      await props.onAdded(added.id);
      props.onClose();
    } catch (caught) {
      const failed = asApiError(caught);
      const byField = fieldErrors(failed);
      if (Object.keys(form).some((key) => byField[key])) setErrors(byField);
      else setError(failed.message);
    } finally {
      setPending(false);
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value }),
  });
  return (
    <D.Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <D.DialogContent>
        <form onSubmit={(event) => void add(event)} noValidate>
          <D.DialogTitle>Add an MCP server</D.DialogTitle>
          <D.DialogDescription>
            A remote server over streamable HTTP. Only you can use it until an admin shares it.
          </D.DialogDescription>
          <div className="grid gap-4 py-4">
            <Field
              label="Name"
              hint="Lowercase, such as tracker. Its tools reach the agent as tracker__<tool>."
              error={errors.name}
            >
              {(control) => (
                <Input {...control} autoFocus className="font-mono" {...field('name')} />
              )}
            </Field>
            <Field label="Address" error={errors.url}>
              {(control) => (
                <Input
                  {...control}
                  className="font-mono"
                  placeholder="https://mcp.example.com/mcp"
                  {...field('url')}
                />
              )}
            </Field>
            <Field
              label="Sign-in"
              hint={
                auth === 'oauth'
                  ? 'Each person signs in in the browser, and their agents use their account. You sign in next.'
                  : undefined
              }
            >
              {(control) => (
                <Select value={auth} onValueChange={(value) => setAuth(value as typeof auth)}>
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="header">A token</SelectItem>
                    <SelectItem value="oauth">OAuth in the browser</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            {auth === 'header' && (
              <Field
                label="Token"
                hint="Optional. Agentome sends it as Authorization: Bearer and the token; it is not shown again and never reaches a person’s computer. Another scheme, such as Basic, can be typed whole."
                error={errors.authorization}
              >
                {(control) => (
                  // Bearer is written for the person: the token is pasted after it.
                  <div className="relative">
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-ink-3"
                    >
                      Bearer
                    </span>
                    <Input
                      {...control}
                      type="password"
                      autoComplete="off"
                      className="pl-[72px] font-mono"
                      {...field('authorization')}
                    />
                  </div>
                )}
              </Field>
            )}
            <Field label="What it does" error={errors.description}>
              {(control) => <Input {...control} {...field('description')} />}
            </Field>
            {error && <FormError>{error}</FormError>}
          </div>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </D.DialogClose>
            <Button type="submit" disabled={pending || !form.name.trim() || !form.url.trim()}>
              {pending ? 'Connecting…' : auth === 'oauth' ? 'Add and sign in' : 'Add server'}
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}
