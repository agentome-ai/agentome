import { Box } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, asApiError, timeAgo } from '../api';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { Row } from '../ui/list-row';
import { Section } from '../ui/section';
import type { ProjectView } from './projects-data';

// What the project's work needs next to its agent: the services its main repository's
// devcontainer lists, a database or a queue. A person's place on the server runs them beside
// the agent, once an admin has approved the list: the images are the repository's, run on the
// company's server.

/** An image pinned to its digest, short enough for a row: the whole of it is in the dialog. */
const shortDigest = (image: string) =>
  image.replace(/@sha256:([a-f0-9]{12})[a-f0-9]{52}$/, '@sha256:$1…');

export function ServicesSection(props: {
  project: ProjectView;
  canEdit: boolean;
  isAdmin: boolean;
  onChanged: (project: ProjectView) => void;
}) {
  const { project, canEdit, isAdmin } = props;
  const environment = project.environment;
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);

  async function act(path: string, body: unknown, failed: string) {
    setBusy(true);
    try {
      props.onChanged(await api<ProjectView>(path, { method: 'POST', body }));
      return true;
    } catch (caught) {
      toast.error(failed, { description: asApiError(caught).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const services = environment?.services ?? [];
  const main = project.repositories[0];
  const empty = !main
    ? 'No services. They come from the main repository’s devcontainer: add a repository first.'
    : !environment
      ? 'Not read yet. Read the main repository’s devcontainer to see the services it lists.'
      : environment.devcontainer === null
        ? 'No services. The main repository has no devcontainer; a place runs the services its compose file lists.'
        : 'No services. The devcontainer lists none that a place can run.';
  const read =
    environment &&
    `Read from ${environment.devcontainer ?? 'the main repository'} ${timeAgo(environment.readAt)}.`;
  const note =
    environment && services.length > 0
      ? environment.approved
        ? `Approved: people’s places run these beside the agent. ${read}`
        : `Not approved yet: places run these only after an admin approves them. ${read}`
      : undefined;

  return (
    <Section
      title="Services"
      count={services.length}
      note={note}
      action={
        <div className="flex gap-2">
          {isAdmin && environment && services.length > 0 && !environment.approved && (
            <Button size="sm" disabled={busy} onClick={() => setApproving(true)}>
              Approve services
            </Button>
          )}
          {canEdit && main && (
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() =>
                void act(
                  `/api/projects/${project.id}/environment`,
                  undefined,
                  'Couldn’t read the devcontainer',
                )
              }
            >
              {busy ? 'Reading…' : 'Read again'}
            </Button>
          )}
        </div>
      }
      empty={empty}
      isEmpty={services.length === 0 && (environment?.problems.length ?? 0) === 0}
    >
      {services.length > 0 && (
        <ul aria-label="Services" className="-mt-2 grid grid-cols-[minmax(0,1fr)]">
          {services.map((service) => (
            <Row
              key={service.name}
              lead={<Box aria-hidden className="size-4 text-ink-3" strokeWidth={1.75} />}
              name={<span className="truncate font-mono">{service.name}</span>}
              detail={
                <span className="font-mono" title={service.image}>
                  {shortDigest(service.image)}
                </span>
              }
              what={service.name}
            />
          ))}
        </ul>
      )}
      {environment && environment.problems.length > 0 && (
        <div className="mt-1 max-w-150">
          <h3 className="text-small text-ink-2">Left out</h3>
          <ul className="mt-1 grid gap-0.5 text-small text-ink-3">
            {environment.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {environment && (
        <D.Dialog open={approving} onOpenChange={setApproving}>
          <D.DialogContent>
            <D.DialogTitle>Approve these services?</D.DialogTitle>
            <D.DialogDescription>
              People’s places on the company’s server will run these images beside the agents of
              this project, exactly as below: a command runs whatever it says, with the image’s
              user. Each image is pinned to the digest its tag pointed at when the project was read.
              A change to any of it, or a tag pushed again, needs approval again.
            </D.DialogDescription>
            <ul className="grid max-h-[50vh] gap-3 overflow-y-auto font-mono text-small text-ink-2">
              {services.map((service) => (
                <li key={service.name} className="grid min-w-0 gap-0.5">
                  <span className="break-all text-ink">
                    {service.name}: {service.image}
                  </span>
                  <Spec
                    label="Command"
                    lines={service.command ? [service.command.join(' ')] : []}
                  />
                  <Spec
                    label="Environment"
                    lines={Object.entries(service.environment).map(
                      ([key, value]) => `${key}=${value}`,
                    )}
                  />
                  <Spec
                    label="Volumes"
                    lines={service.volumes.map((volume) => `${volume.name} → ${volume.target}`)}
                  />
                </li>
              ))}
            </ul>
            <D.DialogFooter>
              <D.DialogClose asChild>
                <Button variant="quiet">Cancel</Button>
              </D.DialogClose>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void act(
                    `/api/projects/${project.id}/environment/approve`,
                    { hash: environment.hash },
                    'Couldn’t approve the services',
                  ).then((done) => done && setApproving(false))
                }
              >
                Approve services
              </Button>
            </D.DialogFooter>
          </D.DialogContent>
        </D.Dialog>
      )}
    </Section>
  );
}

/** One part of a service as it will run, shown in full: what an admin approves is what runs. */
function Spec(props: { label: string; lines: string[] }) {
  if (props.lines.length === 0) return null;
  return (
    <div className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-x-2">
      <span className="font-sans text-ink-3">{props.label}</span>
      <span className="grid min-w-0">
        {props.lines.map((line) => (
          <span key={line} className="break-all whitespace-pre-wrap">
            {line}
          </span>
        ))}
      </span>
    </div>
  );
}
