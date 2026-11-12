import { Ellipsis, KeyRound, Link2, Plus, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { type ApiError, api, asApiError, fieldErrors, formatDate } from '../api';
import { ApiErrorState, useMe } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import * as M from '../ui/dropdown-menu';
import { FormError } from '../ui/field';
import { Select, SelectChip, SelectContent, SelectItem } from '../ui/select';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { leadTile } from '../ui/tint';

// Admin → Models: where agents that work on the server take their models from —
// Anthropic or OpenAI by an API key, or a gateway such as LiteLLM or OpenRouter — as in Open WebUI. The key is
// pasted here and never shown again; a connection is kept once its key lists its models.

type Kind = 'anthropic' | 'openai' | 'gateway';
type Engine = 'claude-code' | 'codex';
type ModelConnection = {
  id: string;
  name: string;
  kind: Kind;
  baseUrl: string;
  models: { id: string; engine: Engine }[];
  checkedAt: string | null;
  createdAt: string;
};

const KINDS: Record<Kind, { label: string; letters: string; url?: string; note: string }> = {
  anthropic: {
    label: 'Anthropic',
    letters: 'AN',
    url: 'https://api.anthropic.com',
    note: 'Claude models, for Claude Code',
  },
  openai: {
    label: 'OpenAI',
    letters: 'OA',
    url: 'https://api.openai.com',
    note: 'GPT models, for Codex',
  },
  gateway: {
    label: 'Gateway',
    letters: 'GW',
    note: 'LiteLLM, OpenRouter or another: Claude for Claude Code, the rest for Codex',
  },
};
/** OpenRouter's address in front of /v1: Claude Code and Codex both reach it there. */
const OPENROUTER = 'https://openrouter.ai/api';
const ENGINES: Record<Engine, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

const host = (url: string) => new URL(url).host;
const counted = (n: number) => `${n} model${n === 1 ? '' : 's'}`;

function KindMark({ kind, className }: { kind: Kind; className?: string }) {
  return (
    <span
      title={KINDS[kind].label}
      className={cn(
        'inline-grid h-4 min-w-5 shrink-0 place-items-center rounded-[3px] bg-desk px-[3px] text-[9.5px] leading-none font-semibold text-ink-2',
        className,
      )}
    >
      <span aria-hidden="true">{KINDS[kind].letters}</span>
      <span className="sr-only">{KINDS[kind].label}</span>
    </span>
  );
}

export function ModelsPage() {
  const me = useMe();
  const [connections, setConnections] = useState<ModelConnection[]>();
  const [error, setError] = useState<ApiError>();
  const [editing, setEditing] = useState<ModelConnection | 'new'>();
  const [showing, setShowing] = useState<ModelConnection>();
  const [deleting, setDeleting] = useState<ModelConnection>();
  const [checking, setChecking] = useState<string>();
  const [rowError, setRowError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const data = await api<{ connections: ModelConnection[] }>('/api/model-connections');
      setConnections(data.connections);
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, []);
  useEffect(() => {
    if (me.role === 'admin') void load();
  }, [load, me.role]);

  async function check(connection: ModelConnection) {
    setChecking(connection.id);
    setRowError(undefined);
    try {
      const fresh = await api<ModelConnection>(`/api/model-connections/${connection.id}/check`, {
        body: {},
      });
      setConnections((was) => was?.map((c) => (c.id === fresh.id ? fresh : c)));
    } catch (caught) {
      setRowError(`${connection.name}: ${asApiError(caught).message}`);
    } finally {
      setChecking(undefined);
    }
  }

  const add = (
    <Button variant="primary" onClick={() => setEditing('new')}>
      <Plus aria-hidden="true" className="size-3.5" />
      New connection
    </Button>
  );
  const header = (actions?: ReactNode) => (
    <PageHeader title="Models" crumbs={[{ label: 'Admin', to: '/admin' }]} actions={actions} />
  );
  if (me.role !== 'admin') {
    return (
      <>
        {header()}
        <EmptyState title="Only admins manage model connections">
          Ask an admin to connect Anthropic, OpenAI or a gateway such as LiteLLM.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {header(connections?.length ? add : undefined)}
      <div className={cn('pt-4 pb-24', frame.wide)}>
        <p className="mb-4 max-w-[72ch] text-read text-ink-2">
          The models agents use when they work on the server, paid by the connection’s API key. On a
          person’s computer, agents keep their owner’s subscription.
        </p>
        {error ? (
          <ApiErrorState title="Couldn't load the model connections" error={error} onRetry={load} />
        ) : !connections ? (
          <LoadingState label="Loading the model connections" />
        ) : connections.length === 0 ? (
          <EmptyState title="No model connections yet" action={add}>
            Connect Anthropic or OpenAI with an API key, or a gateway such as LiteLLM or OpenRouter,
            and agents can work on the server with its models.
          </EmptyState>
        ) : (
          <>
            {rowError && <p className="mb-3 text-small text-failed">{rowError}</p>}
            <Table phoneList className="-mx-3 w-[calc(100%+24px)] table-fixed">
              <colgroup>
                <col className="w-[32%]" />
                <col className="max-lg:hidden" />
                <col className="w-80" />
                <col className="w-32 max-xl:hidden" />
                <col className="w-12" />
              </colgroup>
              <thead>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="max-lg:hidden">Address</TableHead>
                  <TableHead>Models</TableHead>
                  <TableHead className="max-xl:hidden">Checked</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <TableRow key={connection.id} className="relative hover:bg-hover">
                    <TableCell data-lead className="md:hidden">
                      <span className={cn(leadTile, 'grid place-items-center bg-selected')}>
                        <KindMark kind={connection.kind} className="bg-transparent" />
                      </span>
                    </TableCell>
                    <TableCell primary className="font-medium">
                      {/* The name opens the models; its ::after covers the row. */}
                      <button
                        type="button"
                        onClick={() => setShowing(connection)}
                        aria-label={`${connection.name}, ${KINDS[connection.kind].label}`}
                        className="flex w-full min-w-0 items-center gap-2 text-left after:absolute after:inset-0"
                      >
                        <KindMark kind={connection.kind} className="max-md:hidden" />
                        <span className="truncate">{connection.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="truncate text-ink-2 max-lg:hidden">
                      {host(connection.baseUrl)}
                    </TableCell>
                    <TableCell className="text-ink-2">
                      {checking === connection.id ? (
                        'Checking…'
                      ) : (
                        <ModelCount connection={connection} />
                      )}
                    </TableCell>
                    <TableCell className="text-ink-2 max-xl:hidden">
                      {connection.checkedAt && formatDate(connection.checkedAt)}
                    </TableCell>
                    <TableCell data-menu className="relative z-1 py-0 pr-2 text-right">
                      <M.DropdownMenu>
                        <M.DropdownMenuTrigger asChild>
                          <Button
                            variant="quiet"
                            size="icon-sm"
                            aria-label={`Actions for ${connection.name}`}
                          >
                            <Ellipsis />
                          </Button>
                        </M.DropdownMenuTrigger>
                        <M.DropdownMenuContent align="end">
                          <M.DropdownMenuItem onSelect={() => setShowing(connection)}>
                            Models
                          </M.DropdownMenuItem>
                          <M.DropdownMenuItem onSelect={() => void check(connection)}>
                            Check now
                          </M.DropdownMenuItem>
                          <M.DropdownMenuItem onSelect={() => setEditing(connection)}>
                            Edit
                          </M.DropdownMenuItem>
                          <M.DropdownMenuSeparator />
                          <M.DropdownMenuItem
                            variant="danger"
                            onSelect={() => setDeleting(connection)}
                          >
                            Delete
                          </M.DropdownMenuItem>
                        </M.DropdownMenuContent>
                      </M.DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </div>
      <ConnectionDialog
        editing={editing}
        onClose={() => setEditing(undefined)}
        onSaved={(saved) =>
          setConnections((was) =>
            was?.some((c) => c.id === saved.id)
              ? was.map((c) => (c.id === saved.id ? saved : c))
              : [...(was ?? []), saved].sort((a, b) => a.name.localeCompare(b.name)),
          )
        }
      />
      <ModelsDialog connection={showing} onClose={() => setShowing(undefined)} />
      <DeleteDialog
        connection={deleting}
        onClose={() => setDeleting(undefined)}
        onDeleted={(id) => setConnections((was) => was?.filter((c) => c.id !== id))}
      />
    </>
  );
}

/** "12 models", and on a wide screen how many each engine runs. */
function ModelCount({ connection }: { connection: ModelConnection }) {
  const claude = connection.models.filter((model) => model.engine === 'claude-code').length;
  const codex = connection.models.length - claude;
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span>{counted(connection.models.length)}</span>
      <span className="truncate text-ink-3 max-md:hidden">
        {[claude && `${claude} Claude Code`, codex && `${codex} Codex`].filter(Boolean).join(', ')}
      </span>
    </span>
  );
}

/** A connection's models under the engine that runs each, as its last check read them. */
function ModelsDialog(props: { connection?: ModelConnection; onClose: () => void }) {
  const connection = props.connection;
  return (
    <D.Dialog open={connection !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent>
        <D.DialogTitle>{connection?.name}</D.DialogTitle>
        <D.DialogDescription>
          {connection &&
            `${counted(connection.models.length)} at ${host(connection.baseUrl)}${connection.checkedAt ? `, checked ${formatDate(connection.checkedAt)}` : ''}.`}
        </D.DialogDescription>
        {connection &&
          (['claude-code', 'codex'] as const).map((engine) => {
            const models = connection.models.filter((model) => model.engine === engine);
            if (models.length === 0) return null;
            return (
              <section key={engine} aria-label={ENGINES[engine]}>
                <h3 className="mb-1.5 text-small text-ink-3">{ENGINES[engine]}</h3>
                <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                  {models.map((model) => (
                    <li key={model.id} className="truncate px-3 py-1.5 font-mono text-small">
                      {model.id}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button>Close</Button>
          </D.DialogClose>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}

/** New connection and Edit, as a composer: the name large, the kind as a chip, address and key. */
function ConnectionDialog(props: {
  editing?: ModelConnection | 'new';
  onClose: () => void;
  onSaved: (connection: ModelConnection) => void;
}) {
  return (
    <D.Dialog open={props.editing !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent
        size="wide"
        className={D.composer}
        onOpenAutoFocus={(event) => {
          const name = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
            '[data-field="name"]',
          );
          if (!name) return;
          event.preventDefault();
          name.focus();
        }}
      >
        {props.editing !== undefined && (
          <ConnectionForm
            editing={props.editing === 'new' ? undefined : props.editing}
            onSaved={(saved) => {
              props.onSaved(saved);
              props.onClose();
            }}
          />
        )}
      </D.DialogContent>
    </D.Dialog>
  );
}

function ConnectionForm(props: {
  editing?: ModelConnection;
  onSaved: (c: ModelConnection) => void;
}) {
  const was = props.editing;
  const [name, setName] = useState(was?.name ?? '');
  const [kind, setKind] = useState<Kind>(was?.kind ?? 'gateway');
  const [baseUrl, setBaseUrl] = useState(was?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const form = useRef<HTMLFormElement>(null);
  const fields = error ? fieldErrors(error) : {};
  const ready =
    name.trim() !== '' &&
    (was ? true : key.trim() !== '') &&
    (kind !== 'gateway' || baseUrl.trim() !== '');

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending || !ready) return;
    setPending(true);
    setError(undefined);
    try {
      const address = baseUrl.trim() || undefined;
      const saved = was
        ? await api<ModelConnection>(`/api/model-connections/${was.id}`, {
            method: 'PATCH',
            body: {
              ...(name.trim() !== was.name && { name: name.trim() }),
              ...(address && address !== was.baseUrl && { baseUrl: address }),
              ...(key.trim() && { key: key.trim() }),
            },
          })
        : await api<ModelConnection>('/api/model-connections', {
            body: {
              name: name.trim(),
              kind,
              key: key.trim(),
              ...(address && { baseUrl: address }),
            },
          });
      props.onSaved(saved);
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  const title = was ? 'Edit model connection' : 'New model connection';
  return (
    <form
      ref={form}
      onSubmit={(event) => void save(event)}
      noValidate
      className="flex flex-col"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        form.current?.requestSubmit();
      }}
    >
      <div className="flex items-center gap-2 pt-3 pr-3 pl-5 max-md:grid max-md:grid-cols-[1fr_auto_1fr] max-md:border-b max-md:border-line max-md:px-2 max-md:py-2">
        <D.DialogClose asChild>
          <Button variant="quiet" type="button" className="justify-self-start md:hidden">
            Cancel
          </Button>
        </D.DialogClose>
        <D.DialogTitle className="text-ui text-ink-2 max-md:text-section max-md:text-ink">
          {title}
        </D.DialogTitle>
        <D.DialogDescription className="sr-only">
          Where agents that work on the server take their models from.
        </D.DialogDescription>
        <D.DialogClose asChild>
          <Button
            variant="quiet"
            size="icon-sm"
            type="button"
            aria-label="Close"
            className="ml-auto max-md:hidden"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </D.DialogClose>
      </div>
      <div className="grid gap-1.5 px-5 pt-3 max-md:px-4 max-md:pt-4">
        <input
          data-field="name"
          aria-label="Name"
          aria-invalid={fields.name ? true : undefined}
          placeholder="Connection name"
          maxLength={100}
          value={name}
          className="bg-transparent text-title text-ink outline-none placeholder:text-ink-3"
          onChange={(event) => setName(event.target.value)}
        />
        <p className="text-read text-ink-3">{KINDS[kind].note}.</p>
      </div>
      <div className="grid gap-3 px-5 pt-4 pb-4 max-md:px-4">
        <div role="group" aria-label="About this connection" className="flex flex-wrap gap-1.5">
          <Select value={kind} onValueChange={(value) => setKind(value as Kind)} disabled={!!was}>
            <SelectChip aria-label={`Kind: ${KINDS[kind].label}`}>
              <KindMark kind={kind} />
              <span className="truncate">{KINDS[kind].label}</span>
            </SelectChip>
            <SelectContent>
              {(Object.keys(KINDS) as Kind[]).map((value) => (
                <SelectItem key={value} value={value} description={KINDS[value].note}>
                  {KINDS[value].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Fields as the chips' row reads them: only a gateway must be given its address. */}
        <label className="flex items-center gap-2 rounded-md border border-line-control bg-raised px-2.5 has-aria-invalid:border-failed has-focus-visible:border-ink has-focus-visible:outline-1 has-focus-visible:outline-offset-0">
          <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
          <input
            aria-label="Address"
            aria-invalid={fields.baseUrl ? true : undefined}
            inputMode="url"
            placeholder={
              KINDS[kind].url ?? 'The gateway’s address, such as https://litellm.acme.com'
            }
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="h-9 min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        <label className="flex items-center gap-2 rounded-md border border-line-control bg-raised px-2.5 has-aria-invalid:border-failed has-focus-visible:border-ink has-focus-visible:outline-1 has-focus-visible:outline-offset-0">
          <KeyRound aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
          <input
            aria-label="API key"
            aria-invalid={fields.key ? true : undefined}
            type="password"
            autoComplete="off"
            placeholder={was ? 'Leave empty to keep the current key' : 'API key'}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="h-9 min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        <p className="text-small text-ink-3">
          {kind === 'gateway' && !baseUrl && (
            <>
              <button
                type="button"
                className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink"
                onClick={() => setBaseUrl(OPENROUTER)}
              >
                Use OpenRouter
              </button>{' '}
              or the address of the company’s LiteLLM.{' '}
            </>
          )}
          Give a key made for agents, with a spending limit at the provider: it is what a leak could
          cost.
        </p>
        {Object.entries(fields).map(([field, message]) => (
          <p key={field} className="text-small text-failed">
            {message}
          </p>
        ))}
        {error && Object.keys(fields).length === 0 && <FormError>{error.message}</FormError>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line py-3 pr-4 pl-5 max-md:px-4">
        <p className="min-w-0 text-small text-ink-3">
          Agentome lists its models to check the key, and keeps the key encrypted.
        </p>
        <Button
          variant="primary"
          type="submit"
          disabled={pending || !ready}
          title="⌘↵"
          className="ml-auto"
        >
          {pending ? 'Checking…' : was ? 'Save' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}

function DeleteDialog(props: {
  connection?: ModelConnection;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const connection = props.connection;

  async function remove() {
    if (!connection) return;
    setPending(true);
    try {
      await api(`/api/model-connections/${connection.id}`, { method: 'DELETE' });
      props.onDeleted(connection.id);
      props.onClose();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog
      open={connection !== undefined}
      onOpenChange={(open) => {
        if (open) return;
        setError(undefined);
        props.onClose();
      }}
    >
      <D.DialogContent>
        <D.DialogTitle>Delete {connection?.name}?</D.DialogTitle>
        <D.DialogDescription>
          Its key is erased, and agents on its models can’t work on the server until they get
          another connection. Add it again with the key to undo this.
        </D.DialogDescription>
        {error && <FormError>{error}</FormError>}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="quiet">Cancel</Button>
          </D.DialogClose>
          <Button variant="danger" disabled={pending} onClick={() => void remove()}>
            Delete connection
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}
