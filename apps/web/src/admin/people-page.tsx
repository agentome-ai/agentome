import { Ellipsis, Mail } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type ApiError, api, asApiError, formatDate, type Role } from '../api';
import { TransferAgentsDialog } from '../agents/transfer-dialog';
import { ApiErrorState, useMe } from '../session';
import { isOnline, useSeats, type Seat } from './seats-data';
import { Link } from 'react-router';
import { Presence, Status } from '../ui/status';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import * as M from '../ui/dropdown-menu';
import { leadTile, PersonAvatar } from '../ui/tint';
import { Field, FormError } from '../ui/field';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';

type Person = { id: string; name: string; email: string; role: Role; disabledAt: string | null };
type Invitation = {
  id: string;
  role: Role;
  email: string | null;
  invitedBy: string;
  expiresAt: string;
};
type Confirmation = {
  title: string;
  description: string;
  action: string;
  run: () => Promise<unknown>;
};

const roleLabel: Record<Role, string> = { admin: 'Admin', member: 'Member' };

export function PeoplePage() {
  const me = useMe();
  const [data, setData] = useState<{ people: Person[]; invitations: Invitation[] }>();
  const [error, setError] = useState<ApiError>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [handing, setHanding] = useState<Person>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [people, pending] = await Promise.all([
        api<{ users: Person[] }>('/api/users'),
        api<{ invitations: Invitation[] }>('/api/invitations'),
      ]);
      setData({ people: people.users, invitations: pending.invitations });
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, []);
  useEffect(() => {
    if (me.role === 'admin') void load();
  }, [load, me.role]);

  const setDisabled = (person: Person, disabled: boolean) =>
    api(`/api/users/${person.id}`, { method: 'PATCH', body: { disabled } }).then(load);

  async function enable(person: Person) {
    try {
      await setDisabled(person, false);
    } catch (caught) {
      toast.error(`Couldn't enable ${person.name}`, { description: asApiError(caught).message });
    }
  }

  const { seats } = useSeats();
  const header = (actions?: ReactNode) => (
    <PageHeader title="People" crumbs={[{ label: 'Admin', to: '/admin' }]} actions={actions} />
  );
  if (me.role !== 'admin') {
    return (
      <>
        {header()}
        <EmptyState title="Only admins can manage people">
          Ask an admin to invite someone or to change who can sign in.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {header(<InviteDialog onCreated={load} />)}
      <div className={cn(frame.wide, 'pt-4 pb-24')}>
        {error ? (
          <ApiErrorState title="Couldn't load people" error={error} onRetry={load} />
        ) : !data ? (
          <LoadingState label="Loading people" />
        ) : (
          <>
            <Grid
              headings={['Name', 'Email', 'Role', 'Computer']}
              widths={['w-[28%]', '', 'w-28', 'w-52']}
            >
              {data.people.map((person) => (
                <TableRow key={person.id} className={cn(person.disabledAt && 'text-ink-3')}>
                  <TableCell data-lead className="md:hidden">
                    <PersonAvatar
                      id={person.id}
                      name={person.name}
                      className={cn(leadTile, 'rounded-full')}
                    />
                  </TableCell>
                  <TableCell
                    primary
                    className={cn('font-medium', person.disabledAt && 'text-ink-3')}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <PersonAvatar id={person.id} name={person.name} className="max-md:hidden" />
                      <span className="truncate">{person.name}</span>
                      {person.id === me.id && <span className="font-normal text-ink-3">You</span>}
                      {person.disabledAt && (
                        <span className="font-normal text-ink-3">Disabled</span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-ink-2 max-md:hidden">{person.email}</TableCell>
                  <TableCell className="text-ink-2">{roleLabel[person.role]}</TableCell>
                  <TableCell>
                    <Computer seats={seats?.filter((seat) => seat.owner.id === person.id) ?? []} />
                  </TableCell>
                  <TableCell data-menu className="py-0 pr-2 text-right">
                    {/* Nobody disables themselves: the installation keeps an admin who can sign in. */}
                    {person.id !== me.id && (
                      <RowMenu label={`Actions for ${person.name}`}>
                        <M.DropdownMenuItem onSelect={() => setHanding(person)}>
                          Transfer agents
                        </M.DropdownMenuItem>
                        {person.disabledAt ? (
                          <M.DropdownMenuItem onSelect={() => void enable(person)}>
                            Enable
                          </M.DropdownMenuItem>
                        ) : (
                          <M.DropdownMenuItem
                            variant="danger"
                            onSelect={() =>
                              setConfirmation({
                                title: `Disable ${person.name}?`,
                                description: `${person.name} is signed out everywhere and can't sign in until an admin enables the account again.`,
                                action: 'Disable',
                                run: () => setDisabled(person, true),
                              })
                            }
                          >
                            Disable
                          </M.DropdownMenuItem>
                        )}
                      </RowMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </Grid>

            <h2 className="mt-10 mb-2 text-ui font-medium text-ink-2 max-md:mx-1">
              Pending invitations
            </h2>
            {data.invitations.length === 0 ? (
              <p className="text-ink-2">No pending invitations. Invite someone to get a link.</p>
            ) : (
              <Grid
                headings={['For', 'Invited by', 'Role', 'Expires']}
                widths={['w-[28%]', '', 'w-28', 'w-52']}
              >
                {data.invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell data-lead className="md:hidden">
                      <span
                        className={cn(
                          leadTile,
                          'grid place-items-center rounded-full border border-dashed border-line-strong text-ink-3',
                        )}
                      >
                        <Mail aria-hidden="true" className="size-4" />
                      </span>
                    </TableCell>
                    <TableCell primary className="font-medium">
                      <span className="flex min-w-0 items-center gap-2">
                        <Mail
                          aria-hidden="true"
                          className="size-4 shrink-0 text-ink-3 max-md:hidden"
                        />
                        <span className="truncate">
                          {invitation.email ?? 'Anyone with the link'}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-ink-2 max-md:hidden">
                      {invitation.invitedBy}
                    </TableCell>
                    <TableCell className="text-ink-2">{roleLabel[invitation.role]}</TableCell>
                    <TableCell className="text-ink-2">
                      <span className="md:hidden">Expires </span>
                      {formatDate(invitation.expiresAt)}
                    </TableCell>
                    <TableCell data-menu className="py-0 pr-2 text-right">
                      <RowMenu
                        label={`Actions for the invitation for ${invitation.email ?? 'anyone with the link'}`}
                      >
                        <M.DropdownMenuItem
                          variant="danger"
                          onSelect={() =>
                            setConfirmation({
                              title: invitation.email
                                ? `Revoke the invitation for ${invitation.email}?`
                                : 'Revoke the invitation link?',
                              description:
                                'The link stops working at once. You can create a new one at any time.',
                              action: 'Revoke',
                              run: () =>
                                api(`/api/invitations/${invitation.id}`, { method: 'DELETE' }).then(
                                  load,
                                ),
                            })
                          }
                        >
                          Revoke
                        </M.DropdownMenuItem>
                      </RowMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </Grid>
            )}
          </>
        )}
      </div>
      <ConfirmDialog confirmation={confirmation} onDone={() => setConfirmation(undefined)} />
      <TransferAgentsDialog
        from={handing}
        people={(data?.people ?? []).filter((person) => !person.disabledAt)}
        onClose={() => setHanding(undefined)}
      />
    </>
  );
}

// Both tables share one grid, so Role sits under Role and the actions line up. A page table
// reaches 12 px into the gutters, so its first column lines up with the title.
/**
 * Whose computer is on: the person's active seats, as the dashboard counts them. Admin,
 * Computers has the machines themselves.
 */
function Computer({ seats }: { seats: Seat[] }) {
  const active = seats.filter((seat) => seat.status === 'active');
  const online = active.filter((seat) => isOnline(seat));
  const busy = online.find((seat) => seat.activeRun);
  if (active.length === 0) return <span className="text-ink-3">Not connected</span>;
  return (
    <Link to="/admin/computers" className="relative z-1 hover:underline">
      {busy ? (
        <Status status="running">Running {busy.activeRun?.agentName}</Status>
      ) : online.length > 0 ? (
        <Presence online>Online</Presence>
      ) : (
        <Presence online={false} className="text-ink-3">
          Offline
        </Presence>
      )}
    </Link>
  );
}

// `widths` is one class per column but the actions. A phone reads the table as a list: the
// name first, the role and the rest quiet under it, the menu where the chevron would be.
function Grid(props: { headings: string[]; widths: string[]; children: ReactNode }) {
  const { headings, widths, children } = props;
  return (
    <Table phoneList className="-mx-3 w-[calc(100%+24px)] table-fixed">
      <colgroup>
        {widths.map((width, i) => (
          <col key={i} className={cn(width, i === 1 && 'max-md:hidden')} />
        ))}
        <col className="w-12" />
      </colgroup>
      <thead>
        <TableRow>
          {headings.map((heading, i) => (
            <TableHead key={heading} className={cn(i === 1 && 'max-md:hidden')}>
              {heading}
            </TableHead>
          ))}
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </thead>
      <tbody>{children}</tbody>
    </Table>
  );
}

// The label names the row, so a screen reader says what the menu acts on.
function RowMenu(props: { label: string; children: ReactNode }) {
  return (
    <M.DropdownMenu>
      <M.DropdownMenuTrigger asChild>
        <Button variant="quiet" size="icon-sm" aria-label={props.label}>
          <Ellipsis />
        </Button>
      </M.DropdownMenuTrigger>
      <M.DropdownMenuContent align="end">{props.children}</M.DropdownMenuContent>
    </M.DropdownMenu>
  );
}

/** Asks before an action that cannot be taken back quietly: the question names its object. */
function ConfirmDialog(props: { confirmation?: Confirmation; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const close = () => {
    setError(undefined);
    props.onDone();
  };

  async function confirm() {
    setPending(true);
    try {
      await props.confirmation?.run();
      close();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog open={props.confirmation !== undefined} onOpenChange={(open) => !open && close()}>
      <D.DialogContent>
        <D.DialogTitle>{props.confirmation?.title}</D.DialogTitle>
        <D.DialogDescription>{props.confirmation?.description}</D.DialogDescription>
        {error && <FormError>{error}</FormError>}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="quiet">Cancel</Button>
          </D.DialogClose>
          <Button variant="danger" disabled={pending} onClick={confirm}>
            {props.confirmation?.action}
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}

/** Creates a single-use link; the link is shown here only, since the server keeps its hash. */
function InviteDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>('member');
  const [link, setLink] = useState<{ url: string; expiresAt: string }>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'select'>();
  const linkInput = useRef<HTMLInputElement>(null);

  function change(next: boolean) {
    setOpen(next);
    if (next) return;
    setRole('member');
    setLink(undefined);
    setError(undefined);
    setCopied(undefined);
  }

  async function create() {
    setPending(true);
    setError(undefined);
    try {
      setLink(
        await api<{ url: string; expiresAt: string }>('/api/invitations', { body: { role } }),
      );
      onCreated();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link?.url ?? '');
      setCopied('yes');
    } catch {
      // No clipboard access, as on a plain-http address: leave the link selected instead.
      if (linkInput.current) selectAll(linkInput.current);
      setCopied('select');
    }
  }
  // The field keeps showing the start of the address, not the end of the token.
  const selectAll = (input: HTMLInputElement) => {
    input.select();
    requestAnimationFrame(() => (input.scrollLeft = 0));
  };

  return (
    <D.Dialog open={open} onOpenChange={change}>
      <D.DialogTrigger asChild>
        <Button variant="primary">Invite someone</Button>
      </D.DialogTrigger>
      <D.DialogContent>
        <D.DialogTitle>Invite someone</D.DialogTitle>
        {link ? (
          <>
            <D.DialogDescription>
              Send this link to the person you invite. It works once, until{' '}
              {formatDate(link.expiresAt)}. Copy it now: it won&apos;t be shown again.
            </D.DialogDescription>
            <Field
              label="Invitation link"
              hint={
                copied === 'select'
                  ? 'The link is selected: copy it with your keyboard.'
                  : undefined
              }
            >
              {(control) => (
                <div className="flex gap-2">
                  {/* The Create link button is gone; focus lands on the link, selected. */}
                  <Input
                    {...control}
                    ref={linkInput}
                    autoFocus
                    readOnly
                    value={link.url}
                    onFocus={(event) => selectAll(event.currentTarget)}
                    className="font-mono text-small"
                  />
                  <Button variant="primary" onClick={copy}>
                    {copied === 'yes' ? 'Copied' : 'Copy link'}
                  </Button>
                </div>
              )}
            </Field>
            <D.DialogFooter>
              <D.DialogClose asChild>
                <Button>Done</Button>
              </D.DialogClose>
            </D.DialogFooter>
          </>
        ) : (
          <>
            <D.DialogDescription>
              They create their own account from the link. It works once and expires in 7 days.
            </D.DialogDescription>
            <Field label="Role">
              {(control) => (
                <Select value={role} onValueChange={(value) => setRole(value as Role)}>
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member" description="Works with agents and tasks">
                      Member
                    </SelectItem>
                    <SelectItem
                      value="admin"
                      description="Also manages people and settings in Admin"
                    >
                      Admin
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            {error && <FormError>{error}</FormError>}
            <D.DialogFooter>
              <D.DialogClose asChild>
                <Button variant="quiet">Cancel</Button>
              </D.DialogClose>
              <Button variant="primary" disabled={pending} onClick={create}>
                Create link
              </Button>
            </D.DialogFooter>
          </>
        )}
      </D.DialogContent>
    </D.Dialog>
  );
}
