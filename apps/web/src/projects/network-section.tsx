import { Globe, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type ApiError, api, asApiError, fieldErrors, timeAgo } from '../api';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { DropdownMenuItem } from '../ui/dropdown-menu';
import { Field, FormError } from '../ui/field';
import { Input } from '../ui/input';
import { Row } from '../ui/list-row';
import { Section } from '../ui/section';
import type { ProjectView } from './projects-data';

// What the project's runs in people's places on the server may reach past Agentome and the
// model's vendor: the company's GitLab, Jira, a package mirror. An admin's list, changed in the
// browser only. A run that asked for another host was refused it at the egress proxy: those of
// the last week are listed here, for an admin to allow at once, instead of finding them in the log.

type Refused = { host: string; port: number; count: number; lastAt: string };

/** The public package registries a project's builds commonly reach, when it has no mirror. */
export const PUBLIC_REGISTRIES = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'proxy.golang.org',
  'sum.golang.org',
  'api.nuget.org',
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  // Docker Hub hands out an image's layers from either CDN.
  'production.cloudfront.docker.com',
];

/**
 * A host's name with its last two labels apart: who owns a name is read from its end, and a long
 * name made to start like the company's (gitlab.corp.example.com.x.attacker.tld) shows its owner.
 */
function HostName({ host }: { host: string }) {
  const labels = host.split('.');
  const owner = labels.length > 2 ? labels.slice(-2).join('.') : host;
  const before = labels.length > 2 ? `${labels.slice(0, -2).join('.')}.` : '';
  return (
    <span className="font-mono break-all">
      <span className="text-ink-2">{before}</span>
      <span className="font-medium text-ink">{owner}</span>
    </span>
  );
}

/** A refused host as the list writes it: its port only when it is not 443. */
const patternOf = (refused: Refused) =>
  refused.port === 443 ? refused.host : `${refused.host}:${String(refused.port)}`;

export function NetworkSection(props: {
  project: ProjectView;
  isAdmin: boolean;
  onChanged: (project: ProjectView) => void;
}) {
  const { project, isAdmin } = props;
  const hosts = project.allowedHosts;
  const [refused, setRefused] = useState<Refused[]>([]);
  const [busy, setBusy] = useState(false);
  // The refused host an admin is about to allow: asked first, its whole name shown.
  const [allowing, setAllowing] = useState<Refused>();

  const loadRefused = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const said = await api<{ hosts: Refused[] }>(`/api/projects/${project.id}/refused-hosts`);
      setRefused(said.hosts);
    } catch {
      // The list of what was refused is a help, not the section: the hosts still show.
      setRefused([]);
    }
  }, [isAdmin, project.id]);
  useEffect(() => void loadRefused(), [loadRefused]);

  async function save(next: string[], failed: string) {
    setBusy(true);
    try {
      props.onChanged(
        await api<ProjectView>(`/api/projects/${project.id}`, {
          method: 'PATCH',
          body: { allowedHosts: next },
        }),
      );
      await loadRefused();
      return true;
    } catch (caught) {
      toast.error(failed, { description: asApiError(caught).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Network"
      count={hosts.length}
      note="What this project’s runs in places on the server may reach, besides Agentome and the model’s vendor."
      action={
        isAdmin && (
          <AddHostDialog
            hosts={hosts}
            onAdd={(added) => save([...new Set([...hosts, ...added])], 'Couldn’t add the host')}
          />
        )
      }
      empty={
        isAdmin
          ? 'No hosts. Runs reach Agentome and the model only: add the company’s GitLab, Jira or package mirror they need.'
          : 'No hosts. Runs reach Agentome and the model only; an admin adds the hosts they need.'
      }
      isEmpty={hosts.length === 0 && refused.length === 0}
    >
      {hosts.length > 0 && (
        <ul aria-label="Allowed hosts" className="-mt-2 grid grid-cols-[minmax(0,1fr)]">
          {hosts.map((host) => (
            <Row
              key={host}
              lead={<Globe aria-hidden className="size-4 text-ink-3" strokeWidth={1.75} />}
              name={<span className="truncate font-mono">{host}</span>}
              what={host}
              menu={
                isAdmin && (
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() =>
                      void save(
                        hosts.filter((other) => other !== host),
                        `Couldn’t remove ${host}`,
                      )
                    }
                  >
                    Remove
                  </DropdownMenuItem>
                )
              }
            />
          ))}
        </ul>
      )}
      {refused.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
          <h3 className="text-small text-ink-2">Refused this week</h3>
          <ul aria-label="Refused hosts" className="grid grid-cols-[minmax(0,1fr)]">
            {refused.map((one) => (
              <Row
                key={patternOf(one)}
                lead={<Globe aria-hidden className="size-4 text-ink-3" strokeWidth={1.75} />}
                name={
                  <span>
                    <HostName host={one.host} />
                    {one.port !== 443 && <span className="font-mono text-ink-2">:{one.port}</span>}
                  </span>
                }
                detail={`${String(one.count)} ${one.count === 1 ? 'time' : 'times'}, last ${timeAgo(one.lastAt)}`}
                what={patternOf(one)}
                action={
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={busy}
                    aria-label={`Allow ${patternOf(one)}`}
                    onClick={() => setAllowing(one)}
                  >
                    Allow
                  </Button>
                }
              />
            ))}
          </ul>
        </div>
      )}
      <D.Dialog
        open={allowing !== undefined}
        onOpenChange={(open) => !open && setAllowing(undefined)}
      >
        <D.DialogContent>
          <D.DialogTitle>Allow this host?</D.DialogTitle>
          <D.DialogDescription>
            Runs of this project will reach it through the egress proxy. A run asked for it, and a
            run may ask for anything: check whose name it is, which its last part says.
          </D.DialogDescription>
          {allowing && (
            <p className="rounded-md border border-line bg-sunken px-3 py-2">
              <HostName host={allowing.host} />
              <span className="font-mono text-ink-2">:{allowing.port}</span>
            </p>
          )}
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button type="button" variant="quiet">
                Cancel
              </Button>
            </D.DialogClose>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const one = allowing;
                if (!one) return;
                void save([...hosts, patternOf(one)], `Couldn’t allow ${patternOf(one)}`).then(() =>
                  setAllowing(undefined),
                );
              }}
            >
              Allow host
            </Button>
          </D.DialogFooter>
        </D.DialogContent>
      </D.Dialog>
    </Section>
  );
}

function AddHostDialog(props: { hosts: string[]; onAdd: (hosts: string[]) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const missing = PUBLIC_REGISTRIES.filter((registry) => !props.hosts.includes(registry));

  async function add(hosts: string[]) {
    setPending(true);
    setError(undefined);
    try {
      if (await props.onAdd(hosts)) setOpen(false);
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  const problem = error && (Object.values(fieldErrors(error))[0] ?? error.message);
  return (
    <D.Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setHost('');
          setError(undefined);
        }
      }}
    >
      <D.DialogTrigger asChild>
        <Button size="icon-sm" variant="quiet" aria-label="Add host">
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </D.DialogTrigger>
      <D.DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void add([host.trim().toLowerCase()]);
          }}
          noValidate
        >
          <D.DialogTitle>Add a host</D.DialogTitle>
          <D.DialogDescription>
            Runs of this project in people’s places reach it through the egress proxy, on port 443
            unless it names another.
          </D.DialogDescription>
          <div className="grid gap-4 py-4">
            <Field
              label="Host"
              hint="A full name, *.example.com for every name under it, or an IPv4 address; :port when not 443."
            >
              {(control) => (
                <Input
                  {...control}
                  autoFocus
                  className="font-mono"
                  placeholder="gitlab.example.com"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                />
              )}
            </Field>
            {problem && <FormError>{problem}</FormError>}
            {missing.length > 0 && (
              <p className="text-small text-ink-2">
                Public package registries also take uploads: npm, Docker Hub and the Gradle plugin
                portal publish what a token sends, and the Go proxy fetches what it is asked for.
                With them, an agent that holds a token of its own could send out what it read. A
                read-only mirror of your own, added by its name, is the safer way.
              </p>
            )}
          </div>
          <D.DialogFooter>
            {missing.length > 0 && (
              <Button
                type="button"
                variant="quiet"
                disabled={pending}
                onClick={() => void add(missing)}
              >
                Add public package registries
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={pending || !host.trim()}>
              Add host
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}
