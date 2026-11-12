import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { type ApiError, api, asApiError, fieldErrors } from '../api';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Input } from '../ui/input';
import { DropdownMenuItem } from '../ui/dropdown-menu';
import { HostGlyph } from '../ui/host-glyph';
import { Section } from '../ui/section';
import { Row } from '../ui/list-row';
import type { ProjectView } from './projects-data';

/**
 * The repositories the project's agents work in. The first is the main one: a task from Jira
 * starts there, and a new task offers it. Each change sends the whole list. Under them, as whom
 * the agents reach them: the code host connections.
 */
export function RepositoriesSection(props: {
  project: ProjectView;
  isAdmin: boolean;
  onSaved: () => Promise<void>;
}) {
  const { project, isAdmin } = props;
  const [busy, setBusy] = useState(false);

  async function save(repositories: string[], failed: string) {
    setBusy(true);
    try {
      await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { repositories } });
      await props.onSaved();
    } catch (caught) {
      toast.error(failed, { description: asApiError(caught).message });
    } finally {
      setBusy(false);
    }
  }

  const list = project.repositories;
  const hosts = project.connections.filter((connection) => connection.kind !== 'jira');
  return (
    <Section
      title="Repositories"
      count={list.length}
      action={isAdmin && <AddRepositoryDialog project={project} onSaved={props.onSaved} />}
      empty={
        isAdmin
          ? 'No repositories yet. Add the ones this project’s agents work in: the first is the main one, where tasks from Jira start.'
          : 'No repositories yet. An admin adds the ones this project’s agents work in.'
      }
      isEmpty={list.length === 0}
    >
      <ul aria-label="Repositories" className="-mt-2 grid grid-cols-[minmax(0,1fr)]">
        {list.map((url, index) => (
          <Row
            key={url}
            lead={<HostGlyph host={url.includes('github.com') ? 'github' : 'gitlab'} />}
            name={<span className="truncate font-mono">{url.replace(/^https?:\/\//, '')}</span>}
            tag={index === 0 ? 'Main' : undefined}
            what={url}
            menu={
              isAdmin && (
                <>
                  {index > 0 && (
                    <DropdownMenuItem
                      disabled={busy}
                      onSelect={() =>
                        void save(
                          [url, ...list.filter((other) => other !== url)],
                          `Couldn't make ${url} the main repository`,
                        )
                      }
                    >
                      Make main
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() =>
                      void save(
                        list.filter((other) => other !== url),
                        `Couldn't remove ${url}`,
                      )
                    }
                  >
                    Remove
                  </DropdownMenuItem>
                </>
              )
            }
          />
        ))}
      </ul>
      <p className="text-small text-ink-3">
        {hosts.length > 0 ? (
          <>
            A task starts in the main one unless it names another. Agents clone, push and open merge
            requests as{' '}
            {hosts.map((connection, index) => (
              <span key={connection.id}>
                {index > 0 && ', '}
                {connection.accountLogin ? (
                  <span className="font-mono text-ink-2">{connection.accountLogin}</span>
                ) : (
                  'an account not checked yet'
                )}{' '}
                on {connection.host}
              </span>
            ))}
            ; the token stays on Agentome.
          </>
        ) : (
          'This project reaches no code host yet, so its agents cannot push.'
        )}
        {isAdmin && (
          <>
            {' '}
            <Link to="/admin/connections" className="text-ink-2 underline underline-offset-2">
              Connections
            </Link>
          </>
        )}
      </p>
    </Section>
  );
}

function AddRepositoryDialog(props: { project: ProjectView; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/projects/${props.project.id}`, {
        method: 'PATCH',
        body: { repositories: [...props.project.repositories, url.trim()] },
      });
      await props.onSaved();
      setOpen(false);
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
          setUrl('');
          setError(undefined);
        }
      }}
    >
      <D.DialogTrigger asChild>
        <Button size="icon-sm" variant="quiet" aria-label="Add repository">
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </D.DialogTrigger>
      <D.DialogContent>
        <form onSubmit={(event) => void add(event)} noValidate>
          <D.DialogTitle>Add a repository</D.DialogTitle>
          <D.DialogDescription>
            {props.project.repositories.length === 0
              ? 'The first repository is the main one: tasks from Jira start there.'
              : 'It goes to the end of the list. Make it main from the list if tasks should start there.'}
          </D.DialogDescription>
          <div className="grid gap-4 py-4">
            <Field
              label="URL"
              hint="Under a GitHub owner or GitLab group this project is connected to."
            >
              {(control) => (
                <Input
                  {...control}
                  autoFocus
                  className="font-mono"
                  placeholder="https://github.com/acme/api"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              )}
            </Field>
            {problem && <FormError>{problem}</FormError>}
          </div>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </D.DialogClose>
            <Button type="submit" variant="primary" disabled={pending || url.trim() === ''}>
              Add repository
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}
