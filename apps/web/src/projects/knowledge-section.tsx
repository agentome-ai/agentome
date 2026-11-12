import { BookOpen, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type ApiError, api, asApiError, timeAgo } from '../api';
import { ApiErrorState } from '../session';
import { LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Input } from '../ui/input';
import { DropdownMenuItem } from '../ui/dropdown-menu';
import { Section } from '../ui/section';
import { Row } from '../ui/list-row';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

// The project's knowledge: markdown of connected repositories that
// its agents search while they work. An admin adds a source; the server syncs it on a schedule.
type Source = {
  id: string;
  repository: string;
  paths: string[];
  lastSyncAt: string | null;
  lastSyncError: string | null;
  documents: number;
};

const shown = (url: string) => url.replace(/^https?:\/\//, '');

function Status({ source }: { source: Source }) {
  if (!source.lastSyncAt) return <span className="text-ink-3">Not synced yet</span>;
  const when = timeAgo(source.lastSyncAt);
  if (source.lastSyncError) return <span className="text-failed">Sync failed {when}</span>;
  const count = `${source.documents} ${source.documents === 1 ? 'document' : 'documents'}`;
  return (
    <span className="text-ink-2">
      {count}, synced {when}
    </span>
  );
}

export function KnowledgeSection(props: {
  projectId: string;
  repositories: string[];
  isAdmin: boolean;
}) {
  const { projectId, isAdmin } = props;
  const [sources, setSources] = useState<Source[] | ApiError>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const load = useCallback(
    () =>
      api<{ sources: Source[] }>(`/api/projects/${projectId}/knowledge`).then(
        (data) => setSources(data.sources),
        (caught: unknown) => setSources(asApiError(caught)),
      ),
    [projectId],
  );
  useEffect(() => void load(), [load]);

  async function act(source: Source, action: 'sync' | 'remove') {
    setBusy(source.id);
    setError(undefined);
    try {
      await api(
        action === 'sync' ? `/api/knowledge/${source.id}/sync` : `/api/knowledge/${source.id}`,
        { method: action === 'sync' ? 'POST' : 'DELETE' },
      );
      await load();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setBusy(undefined);
    }
  }

  if (!sources) return <LoadingState label="Loading the knowledge" />;
  if (!Array.isArray(sources)) {
    return <ApiErrorState title="Couldn't load the knowledge" error={sources} onRetry={load} />;
  }
  return (
    <Section
      title="Knowledge"
      count={sources.length}
      action={
        isAdmin && (
          <AddSourceDialog projectId={projectId} repositories={props.repositories} onAdded={load} />
        )
      }
      empty={
        isAdmin
          ? "No knowledge yet. Add the docs of a connected repository, and this project's agents can search them while they work."
          : 'No knowledge yet. An admin adds the docs of a repository for the agents to search.'
      }
      isEmpty={sources.length === 0}
    >
      <ul aria-label="Knowledge sources" className="-mt-2 grid grid-cols-[minmax(0,1fr)]">
        {sources.map((source) => (
          <Row
            key={source.id}
            lead={<BookOpen aria-hidden="true" className="size-4 text-ink-3" />}
            name={<span className="truncate font-mono">{shown(source.repository)}</span>}
            detail={
              <>
                {busy === source.id ? (
                  <span className="text-ink-2">Syncing…</span>
                ) : (
                  <Status source={source} />
                )}
                <span className="text-ink-3"> · {source.paths.join(', ')}</span>
                {source.lastSyncError && (
                  <span className="block truncate text-ink-2">{source.lastSyncError}</span>
                )}
              </>
            }
            what={shown(source.repository)}
            menu={
              isAdmin && (
                <>
                  <DropdownMenuItem
                    disabled={busy !== undefined}
                    onSelect={() => void act(source, 'sync')}
                  >
                    Sync now
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={busy !== undefined}
                    onSelect={() => void act(source, 'remove')}
                  >
                    Remove
                  </DropdownMenuItem>
                </>
              )
            }
          />
        ))}
      </ul>
      {error && <FormError>{error}</FormError>}
    </Section>
  );
}

/** One of the project's repositories, and which of its files are knowledge. */
function AddSourceDialog(props: {
  projectId: string;
  repositories: string[];
  onAdded: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [repository, setRepository] = useState('');
  const [paths, setPaths] = useState('README.md, docs');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/projects/${props.projectId}/knowledge`, {
        method: 'POST',
        body: {
          repository: repository.trim(),
          paths: paths
            .split(',')
            .map((path) => path.trim())
            .filter(Boolean),
        },
      });
      await props.onAdded();
      setOpen(false);
    } catch (caught) {
      setError(asApiError(caught).message);
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
          setRepository(props.repositories[0] ?? '');
          setPaths('README.md, docs');
          setError(undefined);
        }
      }}
    >
      <D.DialogTrigger asChild>
        <Button size="icon-sm" variant="quiet" aria-label="Add a source">
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </D.DialogTrigger>
      <D.DialogContent>
        <form onSubmit={(event) => void add(event)} noValidate>
          <D.DialogTitle>Add a knowledge source</D.DialogTitle>
          <D.DialogDescription>
            Markdown from one of this project’s repositories. The server reads it through the
            project’s connection and syncs it every hour.
          </D.DialogDescription>
          <div className="grid gap-4 py-4">
            <Field
              label="Repository"
              hint={
                props.repositories.length === 0
                  ? 'This project has no repositories yet. Add one under Repositories first.'
                  : undefined
              }
            >
              {(control) => (
                <Select
                  value={repository}
                  onValueChange={setRepository}
                  disabled={props.repositories.length === 0}
                >
                  <SelectTrigger {...control} autoFocus className="font-mono">
                    <SelectValue placeholder="Choose a repository" />
                  </SelectTrigger>
                  <SelectContent>
                    {props.repositories.map((url) => (
                      <SelectItem key={url} value={url} className="font-mono">
                        {url}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field
              label="Paths"
              hint="Files or folders, separated by commas. A folder brings every markdown file under it."
            >
              {(control) => (
                <Input
                  {...control}
                  className="font-mono"
                  value={paths}
                  onChange={(event) => setPaths(event.target.value)}
                />
              )}
            </Field>
            {error && <FormError>{error}</FormError>}
          </div>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </D.DialogClose>
            <Button type="submit" disabled={pending || repository === '' || !paths.trim()}>
              {pending ? 'Syncing…' : 'Add and sync'}
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}
