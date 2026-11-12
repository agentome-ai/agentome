import { Ellipsis } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { type ApiError, api, asApiError, fieldErrors, formatDate } from '../api';
import {
  place,
  type Connection,
  type ProjectSummary,
  type ProjectView,
} from '../projects/projects-data';
import { ApiErrorState, useMe } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import * as Menu from '../ui/dropdown-menu';
import { Field, FormError, PasswordInput } from '../ui/field';
import { HostLogo, hostName, type Host } from '../ui/host-glyph';
import { Copyable } from '../ui/copyable';
import { Input } from '../ui/input';
import { RadioGroup, RadioTab } from '../ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { leadTile, Tint } from '../ui/tint';

// The Issues go to choice that names no agent: the project's team takes them.
const TEAM = 'team';

// Connections: where the company's agents reach, and whose account they act as. The token
// itself is never shown — the server does not answer it — so the question this page settles
// is the one a person actually asks: whose name will a pull request carry?

type Webhook = { url: string; secret: string };

export function ConnectionsPage() {
  const me = useMe();
  const [data, setData] = useState<{ connections: Connection[]; projects: ProjectSummary[] }>();
  const [error, setError] = useState<ApiError>();
  const [testing, setTesting] = useState<string>();
  const [syncing, setSyncing] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [connections, projects] = await Promise.all([
        api<{ connections: Connection[] }>('/api/connections'),
        api<{ projects: ProjectSummary[] }>('/api/projects'),
      ]);
      setData({ connections: connections.connections, projects: projects.projects });
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, []);
  useEffect(() => {
    if (me.role === 'admin') void load();
  }, [load, me.role]);

  async function test(connection: Connection) {
    setTesting(connection.id);
    try {
      await api(`/api/connections/${connection.id}/test`, { method: 'POST' });
      await load();
    } catch (caught) {
      toast.error(`${place(connection)} did not accept the token`, {
        description: asApiError(caught).message,
      });
    } finally {
      setTesting(undefined);
    }
  }

  async function sync(connection: Connection) {
    setSyncing(connection.id);
    try {
      await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    } catch (caught) {
      toast.error(`Couldn't sync ${place(connection)}`, {
        description: asApiError(caught).message,
      });
    } finally {
      await load();
      setSyncing(undefined);
    }
  }

  const header = (actions?: ReactNode) => (
    <PageHeader title="Connections" crumbs={[{ label: 'Admin', to: '/admin' }]} actions={actions} />
  );
  if (me.role !== 'admin') {
    return (
      <>
        {header()}
        <EmptyState title="Only admins manage connections">
          A connection holds a token for the whole company. Ask an admin to connect a code host to
          your project.
        </EmptyState>
      </>
    );
  }

  const add = data?.projects.length ? (
    <NewConnectionDialog projects={data.projects} onCreated={load} />
  ) : undefined;
  return (
    <>
      {header(data?.connections.length ? add : undefined)}
      <div className={cn(frame.wide, 'pt-4 pb-24')}>
        {error ? (
          <ApiErrorState title="Couldn't load connections" error={error} onRetry={load} />
        ) : !data ? (
          <LoadingState label="Loading connections" />
        ) : data.projects.length === 0 ? (
          <EmptyState title="Create a project first">
            A connection belongs to a project: that is how an agent reaches a repository without
            holding the token itself.
          </EmptyState>
        ) : data.connections.length === 0 ? (
          <EmptyState title="Nothing connected yet" action={add}>
            Connect GitHub or GitLab with a token: agents of the project clone, push and open change
            requests through the server, and the token stays here. Connect Jira to turn its issues
            into tasks.
          </EmptyState>
        ) : (
          <Table phoneList className="-mx-3 w-[calc(100%+24px)] table-fixed">
            <colgroup>
              {/* The project names, an agent's too, are what get cut: they get the room. */}
              <col className="w-[34%]" />
              <col className="max-lg:hidden" />
              <col className="w-56" />
              <col className="w-32 max-xl:hidden" />
              <col className="w-16" />
            </colgroup>
            <thead>
              <TableRow>
                <TableHead>Reaches</TableHead>
                <TableHead className="max-lg:hidden">Project</TableHead>
                <TableHead>Acts as</TableHead>
                <TableHead className="max-xl:hidden">Checked</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.connections.map((connection) => (
                <TableRow key={connection.id}>
                  <TableCell data-lead className="md:hidden">
                    <span className={cn(leadTile, 'grid place-items-center bg-selected')}>
                      <HostLogo host={connection.kind} className="size-4.5" />
                    </span>
                  </TableCell>
                  <TableCell primary className="font-medium">
                    <span className="flex min-w-0 items-center gap-2">
                      <HostLogo host={connection.kind} className="size-4 shrink-0 max-md:hidden" />
                      <span className="truncate">{place(connection)}</span>
                      <span className="sr-only">, {hostName[connection.kind]}</span>
                    </span>
                  </TableCell>
                  {/* A phone says the project and who acts on one line under the place. */}
                  <TableCell className="truncate text-ink-2 max-lg:hidden max-md:block max-md:max-w-full">
                    <span className="inline-flex max-w-full min-w-0 items-center gap-2">
                      <Tint id={connection.project.id} kind="project" className="max-md:hidden" />
                      <span className="truncate">
                        {connection.project.name}
                        <span className="text-ink-3">
                          {connection.kind === 'jira'
                            ? `, issues to ${connection.agent?.name ?? "the project's team"}`
                            : connection.agent
                              ? `, ${connection.agent.name} only`
                              : ', every agent'}
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell
                    className={cn(
                      'truncate',
                      connection.accountLogin ? 'text-ink-2' : 'text-ink-3',
                    )}
                  >
                    {testing === connection.id ? (
                      'Checking…'
                    ) : connection.accountLogin ? (
                      <>
                        <span className="md:hidden">as </span>
                        {connection.accountLogin}
                      </>
                    ) : (
                      'Not checked yet'
                    )}
                  </TableCell>
                  <TableCell className="text-ink-2 max-xl:hidden">
                    {connection.kind === 'jira' ? (
                      <SyncState connection={connection} syncing={syncing === connection.id} />
                    ) : (
                      connection.lastTestedAt && formatDate(connection.lastTestedAt)
                    )}
                  </TableCell>
                  <TableCell data-menu className="py-0 pr-2 text-right">
                    <RowMenu
                      connection={connection}
                      onTest={() => void test(connection)}
                      onSync={() => void sync(connection)}
                      onChanged={load}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}

/** Jira is polled: the column says when it last was, or that the last poll failed. */
function SyncState({ connection, syncing }: { connection: Connection; syncing: boolean }) {
  if (syncing) return 'Syncing…';
  if (connection.syncError) return <span className="text-failed">Sync failed</span>;
  return connection.syncedAt ? formatDate(connection.syncedAt) : 'Not synced yet';
}

function RowMenu(props: {
  connection: Connection;
  onTest: () => void;
  onSync: () => void;
  onChanged: () => Promise<void>;
}) {
  const { connection } = props;
  const [open, setOpen] = useState<'token' | 'webhook' | 'delete'>();
  const close = () => setOpen(undefined);
  return (
    <>
      <Menu.DropdownMenu>
        <Menu.DropdownMenuTrigger asChild>
          <Button variant="quiet" size="icon-sm" aria-label={`Actions for ${place(connection)}`}>
            <Ellipsis aria-hidden="true" />
          </Button>
        </Menu.DropdownMenuTrigger>
        <Menu.DropdownMenuContent align="end">
          <Menu.DropdownMenuItem onSelect={props.onTest}>Check the token</Menu.DropdownMenuItem>
          {/* Jira is polled: there is nothing to paste into it, and no need to wait for it. */}
          {connection.kind === 'jira' && (
            <Menu.DropdownMenuItem onSelect={props.onSync}>Sync issues now</Menu.DropdownMenuItem>
          )}
          {connection.kind !== 'jira' && (
            <Menu.DropdownMenuItem onSelect={() => setOpen('webhook')}>
              Webhook settings
            </Menu.DropdownMenuItem>
          )}
          <Menu.DropdownMenuItem onSelect={() => setOpen('token')}>
            Replace the token
          </Menu.DropdownMenuItem>
          <Menu.DropdownMenuItem variant="danger" onSelect={() => setOpen('delete')}>
            Delete connection
          </Menu.DropdownMenuItem>
        </Menu.DropdownMenuContent>
      </Menu.DropdownMenu>
      {open === 'webhook' && <WebhookDialog connection={connection} onClose={close} />}
      {open === 'token' && (
        <ReplaceTokenDialog connection={connection} onClose={close} onSaved={props.onChanged} />
      )}
      {open === 'delete' && (
        <DeleteDialog connection={connection} onClose={close} onDeleted={props.onChanged} />
      )}
    </>
  );
}

/** What the administrator pastes into the host's webhook settings. */
function WebhookDialog({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const [webhook, setWebhook] = useState<Webhook>();
  const [error, setError] = useState<ApiError>();
  useEffect(() => {
    let current = true;
    api<Webhook>(`/api/connections/${connection.id}/webhook`).then(
      (answer) => current && setWebhook(answer),
      (caught: unknown) => current && setError(asApiError(caught)),
    );
    return () => {
      current = false;
    };
  }, [connection.id]);

  return (
    <Shell title="Webhook settings" onClose={onClose}>
      <D.DialogDescription>
        Add these to {hostName[connection.kind]} so that {place(connection)} tells Agentome when a
        change request or a pipeline changes.
      </D.DialogDescription>
      <div className="grid gap-4 py-4">
        {error ? (
          <FormError>{error.message}</FormError>
        ) : !webhook ? (
          <p className="text-ink-3">Loading…</p>
        ) : (
          <>
            <Labelled label="Payload URL">
              <Copyable label="Copy URL" value={webhook.url} />
            </Labelled>
            <Labelled label="Secret">
              <Copyable label="Copy secret" value={webhook.secret} />
            </Labelled>
          </>
        )}
      </div>
    </Shell>
  );
}

function ReplaceTokenDialog(props: {
  connection: Connection;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/connections/${props.connection.id}`, { method: 'PATCH', body: { token } });
      await props.onSaved();
      props.onClose();
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Shell
      title="Replace the token"
      onClose={props.onClose}
      onSubmit={(event) => void save(event)}
      submit={
        <Button type="submit" disabled={pending || token.trim() === ''}>
          Replace token
        </Button>
      }
    >
      <D.DialogDescription>
        The new token takes over for {place(props.connection)} at once. Check it afterwards to see
        whose account it is.
      </D.DialogDescription>
      <div className="grid gap-4 py-4">
        <Field label={`${hostName[props.connection.kind]} token`} error={error?.message}>
          {(control) => (
            <PasswordInput
              {...control}
              autoFocus
              value={token}
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
            />
          )}
        </Field>
      </div>
    </Shell>
  );
}

function DeleteDialog(props: {
  connection: Connection;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function remove() {
    setPending(true);
    try {
      await api(`/api/connections/${props.connection.id}`, { method: 'DELETE' });
      await props.onDeleted();
      props.onClose();
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Shell
      title={`Delete the connection to ${place(props.connection)}?`}
      onClose={props.onClose}
      submit={
        <Button variant="danger" disabled={pending} onClick={() => void remove()}>
          Delete connection
        </Button>
      }
    >
      <D.DialogDescription>
        {props.connection.kind === 'jira'
          ? 'Issues it finds stop becoming tasks'
          : props.connection.agent
            ? `${props.connection.agent.name} falls back to the project's shared token, if there is one`
            : `Agents of ${props.connection.project.name} without a token of their own stop reaching its repositories`}
        , and this token is erased. Connect it again with a new token to undo this.
      </D.DialogDescription>
      {error && <FormError>{error.message}</FormError>}
    </Shell>
  );
}

/** New connection: a project, a host, where it reaches, and the token. */
function NewConnectionDialog(props: {
  projects: ProjectSummary[];
  onCreated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Host>('github');
  const [projectId, setProjectId] = useState(props.projects[0]?.id ?? '');
  // Empty: the project's shared token, for every agent on it.
  const [agentId, setAgentId] = useState('');
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    setAgentId('');
    setMembers([]);
    if (!projectId) return;
    let current = true;
    api<ProjectView>(`/api/projects/${projectId}`).then(
      (view) => current && setMembers(view.agents),
      () => current && setMembers([]),
    );
    return () => {
      current = false;
    };
  }, [projectId]);
  const [owner, setOwner] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [group, setGroup] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [jql, setJql] = useState('');
  const [statuses, setStatuses] = useState(STATUSES);
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const fields = error ? fieldErrors(error) : {};

  const jira = kind === 'jira';
  const ready =
    projectId !== '' &&
    token.trim() !== '' &&
    (kind === 'github'
      ? owner.trim() !== ''
      : jira
        ? baseUrl.trim() !== '' &&
          projectKey.trim() !== '' &&
          agentId !== '' &&
          Object.values(statuses).every((status) => status.trim() !== '')
        : baseUrl.trim() !== '' && group.trim() !== '');

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const config =
      kind === 'github'
        ? { kind, owner }
        : jira
          ? { kind, baseUrl, projectKey, jql, ...statuses }
          : { kind, baseUrl, group };
    try {
      // "team": the project's team takes the issues, so the connection names no agent.
      const named = agentId && agentId !== TEAM ? { agentId } : {};
      const body = { projectId, config, token, ...named };
      await api('/api/connections', { method: 'POST', body });
      await props.onCreated();
      setOpen(false);
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setKind('github');
          setOwner('');
          setBaseUrl('');
          setGroup('');
          setProjectKey('');
          setJql('');
          setStatuses(STATUSES);
          setAgentId('');
          setToken('');
          setError(undefined);
        }
      }}
    >
      <D.DialogTrigger asChild>
        <Button size="sm">New connection</Button>
      </D.DialogTrigger>
      <D.DialogContent>
        <form onSubmit={(event) => void create(event)} noValidate>
          <D.DialogTitle>New connection</D.DialogTitle>
          <D.DialogDescription>
            {jira
              ? 'Issues of the Jira project become tasks of the agent you pick. Agentome moves them and comments as the account this token belongs to.'
              : 'Agents of the project act as the account this token belongs to. A token of a bot account or of a person both work; the name on their pull requests is the one you give here.'}
          </D.DialogDescription>
          <div className="grid gap-4 py-4">
            <fieldset className="grid gap-1.5">
              <legend className="mb-1.5 font-medium">Connect to</legend>
              {/* The chosen system's mark takes its colour; the others wait in grey. */}
              <RadioGroup
                value={kind}
                onValueChange={(next) => setKind(next as Host)}
                className="grid grid-cols-3 gap-2"
              >
                {(['github', 'gitlab', 'jira'] as const).map((host) => (
                  <RadioTab key={host} value={host} aria-label={hostName[host]}>
                    <HostLogo
                      host={host}
                      className="size-4 shrink-0 grayscale group-data-[state=checked]:grayscale-0 group-data-[state=unchecked]:opacity-60"
                    />
                    {hostName[host]}
                  </RadioTab>
                ))}
              </RadioGroup>
            </fieldset>

            <Field label="Project">
              {(control) => (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger {...control}>
                    <SelectValue placeholder="Pick a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {props.projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            <Field
              label={jira ? 'Issues go to' : 'For'}
              hint={
                jira
                  ? "The agent whose tasks they become, or the project's team: its lead gets them, and starts at once if the project says so."
                  : "An agent with a token of its own acts as that account; the others use the project's."
              }
            >
              {(control) => (
                <Select
                  value={agentId || (jira ? '' : 'every')}
                  onValueChange={(next) => setAgentId(next === 'every' ? '' : next)}
                >
                  <SelectTrigger {...control}>
                    <SelectValue placeholder="Pick an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {!jira && <SelectItem value="every">Every agent of the project</SelectItem>}
                    {jira && <SelectItem value={TEAM}>The project's team</SelectItem>}
                    {members.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {jira ? agent.name : `${agent.name} only`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            {jira ? (
              <>
                <Field
                  label="Jira address"
                  hint="Jira Data Center 10 or newer."
                  error={fields.baseUrl}
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={baseUrl}
                      placeholder="https://jira.acme.com"
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  )}
                </Field>
                <div className="grid grid-cols-[8rem_1fr] gap-3 max-md:grid-cols-1">
                  <Field label="Project key" error={fields.projectKey}>
                    {(control) => (
                      <Input
                        {...control}
                        className="font-mono uppercase"
                        value={projectKey}
                        placeholder="PAY"
                        spellCheck={false}
                        autoCapitalize="characters"
                        autoComplete="off"
                        onChange={(event) => setProjectKey(event.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    label="Filter (optional)"
                    hint="JQL that narrows the project's issues. Agentome looks for new and changed ones every 5 minutes."
                    error={fields.jql}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        className="font-mono"
                        value={jql}
                        placeholder="labels = ai-team"
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(event) => setJql(event.target.value)}
                      />
                    )}
                  </Field>
                </div>
                <fieldset className="grid gap-1.5">
                  <legend className="mb-1.5 font-medium">Move the issue to</legend>
                  <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
                    {STATUS_LABELS.map(([key, label]) => (
                      <Field key={key} label={label} error={fields[key]}>
                        {(control) => (
                          <Input
                            {...control}
                            value={statuses[key]}
                            onChange={(event) =>
                              setStatuses((was) => ({ ...was, [key]: event.target.value }))
                            }
                          />
                        )}
                      </Field>
                    ))}
                  </div>
                  <p className="text-small text-ink-3">
                    Status names exactly as your workflow has them.
                  </p>
                </fieldset>
              </>
            ) : kind === 'github' ? (
              <Field
                label="Owner"
                hint="The user or organization on github.com whose repositories this reaches."
                error={fields.owner}
              >
                {(control) => (
                  <Input
                    {...control}
                    value={owner}
                    placeholder="acme"
                    onChange={(event) => setOwner(event.target.value)}
                  />
                )}
              </Field>
            ) : (
              <>
                <Field label="GitLab address" error={fields.baseUrl}>
                  {(control) => (
                    <Input
                      {...control}
                      value={baseUrl}
                      placeholder="https://gitlab.acme.com"
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label="Group"
                  hint="A group path; subgroups are reached too."
                  error={fields.group}
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={group}
                      placeholder="acme/platform"
                      onChange={(event) => setGroup(event.target.value)}
                    />
                  )}
                </Field>
              </>
            )}

            <Field
              label="Token"
              hint={
                kind === 'github'
                  ? 'A fine-grained token with Contents and Pull requests, read and write.'
                  : jira
                    ? 'A personal access token of the account that may see, move and comment on these issues.'
                    : 'A token with api scope for the group.'
              }
              error={fields.token}
            >
              {(control) => (
                <PasswordInput
                  {...control}
                  value={token}
                  autoComplete="off"
                  onChange={(event) => setToken(event.target.value)}
                />
              )}
            </Field>
            {error && Object.keys(fields).length === 0 && <FormError>{error.message}</FormError>}
          </div>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </D.DialogClose>
            <Button type="submit" disabled={pending || !ready}>
              Connect
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}

// What a run moves a Jira issue to, by name: the defaults of Jira's own workflows.
const STATUSES = { inProgress: 'In Progress', inReview: 'In Review', done: 'Done' };
const STATUS_LABELS = [
  ['inProgress', 'On run start'],
  ['inReview', 'On review'],
  ['done', 'On merge'],
] as const;

const Labelled = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid gap-1.5">
    <p className="font-medium">{label}</p>
    {children}
  </div>
);

/** A dialog that is open because a row's menu opened it: it closes to nothing. */
function Shell(props: {
  title: string;
  children: ReactNode;
  submit?: ReactNode;
  onClose: () => void;
  onSubmit?: (event: React.FormEvent) => void;
}) {
  const body = (
    <>
      <D.DialogTitle>{props.title}</D.DialogTitle>
      {props.children}
      <D.DialogFooter>
        <D.DialogClose asChild>
          <Button type="button" variant="secondary">
            {props.submit ? 'Cancel' : 'Done'}
          </Button>
        </D.DialogClose>
        {props.submit}
      </D.DialogFooter>
    </>
  );
  return (
    <D.Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <D.DialogContent>
        {props.onSubmit ? (
          <form onSubmit={props.onSubmit} noValidate>
            {body}
          </form>
        ) : (
          body
        )}
      </D.DialogContent>
    </D.Dialog>
  );
}
