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
                name={<span className="truncate font-mono">{patternOf(one)}</span>}
                detail={`${String(one.count)} ${one.count === 1 ? 'time' : 'times'}, last ${timeAgo(one.lastAt)}`}
                what={patternOf(one)}
                action={
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={busy}
                    aria-label={`Allow ${patternOf(one)}`}
                    onClick={() =>
                      void save([...hosts, patternOf(one)], `Couldn’t allow ${patternOf(one)}`)
                    }
                  >
                    Allow
                  </Button>
                }
              />
            ))}
          </ul>
        </div>
      )}
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
