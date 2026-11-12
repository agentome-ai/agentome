import { diffLines } from 'diff';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, asApiError, timeAgo } from '../api';
import { ApiErrorState } from '../session';
import { LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Input, Textarea } from '../ui/input';
import { textLink } from '../ui/properties';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

// The markdown renderer loads with the first document opened, as Preview does in the editor.
const Markdown = lazy(() =>
  import('../ui/markdown').then(({ Markdown }) => ({ default: Markdown })),
);

// The agent's memory: markdown documents, each change a version. The
// agent writes through the gateway; the owner reads, edits, compares and reverts here.
type MemoryDocument = {
  path: string;
  version: number;
  content: string;
  updatedAt: string;
  updatedBy: { kind: 'run'; id: string } | { kind: 'user'; id: string; name: string };
};

const NEW_PATH = /^(MEMORY\.md|memory\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md)$/;

function Author({ doc }: { doc: MemoryDocument }) {
  return doc.updatedBy.kind === 'run' ? (
    <>
      by a{' '}
      <Link to={`/runs/${doc.updatedBy.id}`} className={textLink}>
        run
      </Link>
    </>
  ) : (
    <>by {doc.updatedBy.name}</>
  );
}

/** The editor's Memory section: the documents as they are now, each opening in a dialog. */
export function MemorySection(props: { agentId: string; onCount: (count: number) => void }) {
  const { agentId, onCount } = props;
  const [docs, setDocs] = useState<MemoryDocument[] | ApiError>();
  const [open, setOpen] = useState<MemoryDocument | 'new'>();
  const url = `/api/agents/${agentId}/memory`;
  const load = useCallback(
    () =>
      api<{ documents: MemoryDocument[] }>(url).then(
        ({ documents }) => {
          setDocs(documents);
          onCount(documents.length);
          return documents;
        },
        (caught: unknown) => {
          setDocs(asApiError(caught));
          return [];
        },
      ),
    [url, onCount],
  );
  useEffect(() => void load(), [load]);

  if (!docs) return <LoadingState label="Loading memory" />;
  if (docs instanceof ApiError) {
    return <ApiErrorState title="Couldn't load the memory" error={docs} onRetry={load} />;
  }
  return (
    <>
      {docs.length === 0 ? (
        <p className="text-ink-2">
          No memory yet. The agent writes here what it learns for its later runs; you can add a note
          for it too.
        </p>
      ) : (
        <ul className="border-t border-line">
          {docs.map((doc) => (
            <li key={doc.path} className="border-b border-line">
              <button
                type="button"
                onClick={() => setOpen(doc)}
                className="-mx-2 flex w-[calc(100%+16px)] items-baseline gap-3 rounded-md px-2 py-2 text-left hover:bg-hover"
              >
                <code className="font-medium text-ink">{doc.path}</code>
                <span className="ml-auto text-small text-ink-3">
                  Version {doc.version}, {timeAgo(doc.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button className="mt-3" onClick={() => setOpen('new')}>
        Add a document
      </Button>
      <DocumentDialog
        agentId={agentId}
        doc={open}
        onClose={() => setOpen(undefined)}
        onSaved={async (path) => {
          const documents = await load();
          setOpen(documents.find((doc) => doc.path === path));
        }}
      />
    </>
  );
}

function DocumentDialog(props: {
  agentId: string;
  doc: MemoryDocument | 'new' | undefined;
  onClose: () => void;
  onSaved: (path: string) => Promise<void>;
}) {
  const { agentId, doc } = props;
  const creating = doc === 'new';
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState('memory/');
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  // Each document opens on its text, not on whatever the last one was being edited into.
  useEffect(() => {
    setEditing(doc === 'new');
    setPath('memory/');
    setText(doc && doc !== 'new' ? doc.content : '');
    setError(undefined);
  }, [doc]);

  async function save() {
    const target = creating ? path.trim() : doc?.path;
    if (!target || pending) return;
    if (!NEW_PATH.test(target)) {
      setError('Use MEMORY.md or memory/<name>.md, for example memory/stripe.md.');
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/agents/${agentId}/memory`, {
        method: 'PUT',
        body: { path: target, content: text, baseVersion: creating ? 0 : doc?.version },
      });
      setEditing(false);
      await props.onSaved(target);
    } catch (caught) {
      const failure = asApiError(caught);
      setError(
        failure.code === 'memory_conflict'
          ? creating
            ? `${target} already exists. Open it from the list to change it.`
            : 'The agent or someone else changed this document since you opened it. Close it and open it again to see the new version; your text is still here to copy.'
          : failure.message,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog open={doc !== undefined} onOpenChange={(next) => !next && props.onClose()}>
      <D.DialogContent size="wide">
        <D.DialogTitle>
          {creating ? 'Add a memory document' : <code>{doc?.path}</code>}
        </D.DialogTitle>
        <D.DialogDescription>
          {doc && doc !== 'new' ? (
            <>
              Version {doc.version}, <Author doc={doc} />, {timeAgo(doc.updatedAt)}.
            </>
          ) : (
            'The agent reads it in every run, beside its instructions.'
          )}
        </D.DialogDescription>
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {creating && (
              <Field label="Path" hint="MEMORY.md, or a file in memory/.">
                {(control) => (
                  <Input
                    {...control}
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                  />
                )}
              </Field>
            )}
            <Field label="Text" hint="Markdown. Saving makes a new version; the old one stays.">
              {(control) => (
                <Textarea
                  {...control}
                  rows={14}
                  className="font-mono text-ui"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              )}
            </Field>
            {error && <FormError>{error}</FormError>}
            <D.DialogFooter>
              <Button
                variant="quiet"
                onClick={() => (creating ? props.onClose() : setEditing(false))}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={pending || !text.trim()}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </D.DialogFooter>
          </form>
        ) : (
          doc &&
          doc !== 'new' && (
            <Tabs defaultValue="document">
              <TabsList aria-label="View">
                <TabsTrigger value="document">Document</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              <TabsContent value="document" className="mt-4">
                <div className="max-h-[50dvh] overflow-y-auto">
                  <Suspense fallback={<LoadingState label="Loading" />}>
                    <Markdown>{doc.content}</Markdown>
                  </Suspense>
                </div>
                <D.DialogFooter>
                  <Button onClick={() => setEditing(true)}>Edit</Button>
                </D.DialogFooter>
              </TabsContent>
              <TabsContent value="history" className="mt-4">
                <History agentId={agentId} doc={doc} onReverted={() => props.onSaved(doc.path)} />
              </TabsContent>
            </Tabs>
          )
        )}
      </D.DialogContent>
    </D.Dialog>
  );
}

/** Every version, the chosen one compared line by line with the one before it, and Revert. */
function History(props: { agentId: string; doc: MemoryDocument; onReverted: () => Promise<void> }) {
  const { agentId, doc } = props;
  const [versions, setVersions] = useState<MemoryDocument[] | ApiError>();
  const [chosen, setChosen] = useState(doc.version);
  const [error, setError] = useState<string>();
  const load = useCallback(
    () =>
      api<{ versions: MemoryDocument[] }>(
        `/api/agents/${agentId}/memory/versions?path=${encodeURIComponent(doc.path)}`,
      ).then(
        ({ versions: all }) => setVersions(all),
        (caught: unknown) => setVersions(asApiError(caught)),
      ),
    [agentId, doc.path],
  );
  useEffect(() => void load(), [load]);

  if (!versions) return <LoadingState label="Loading versions" />;
  if (versions instanceof ApiError) {
    return <ApiErrorState title="Couldn't load the versions" error={versions} onRetry={load} />;
  }
  const index = versions.findIndex((version) => version.version === chosen);
  const current = versions[index];
  const before = versions[index + 1];

  async function revert(version: number) {
    setError(undefined);
    try {
      await api(`/api/agents/${agentId}/memory/revert`, {
        method: 'POST',
        body: { path: doc.path, version },
      });
      await props.onReverted();
    } catch (caught) {
      setError(asApiError(caught).message);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[160px_minmax(0,1fr)]">
      <ul aria-label="Versions" className="grid content-start gap-px">
        {versions.map((version) => (
          <li key={version.version}>
            <button
              type="button"
              aria-pressed={version.version === chosen}
              onClick={() => setChosen(version.version)}
              className={cn(
                'w-full rounded-md px-2 py-1.5 text-left hover:bg-hover',
                version.version === chosen && 'bg-selected',
              )}
            >
              <span className="block font-medium">
                Version {version.version}
                {version.content === '' && <span className="font-normal text-ink-3"> deleted</span>}
              </span>
              <span className="text-small text-ink-3">{timeAgo(version.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0">
        {current && (
          <>
            <p className="mb-2 text-small text-ink-2">
              {before ? `Changes from version ${before.version}, ` : 'The first version, '}
              <Author doc={current} />.
            </p>
            <Changes before={before?.content ?? ''} after={current.content} />
            {current.version !== versions[0]?.version && (
              <Button className="mt-3" onClick={() => void revert(current.version)}>
                Revert to version {current.version}
              </Button>
            )}
          </>
        )}
        {error && (
          <div className="mt-3">
            <FormError>{error}</FormError>
          </div>
        )}
      </div>
    </div>
  );
}

/** A line diff: removed lines struck on the failed tint, added ones on the running tint. */
function Changes({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre
      aria-label="Changes"
      className="max-h-[50dvh] overflow-auto rounded-md bg-desk p-3 font-mono text-ui leading-5 whitespace-pre-wrap"
    >
      {parts.map((part, i) =>
        part.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line, j) => (
            <span
              key={`${i}-${j}`}
              className={cn(
                'block',
                part.added && 'bg-running/12 text-ink',
                part.removed && 'bg-failed/12 text-ink-2 line-through',
                !part.added && !part.removed && 'text-ink-3',
              )}
            >
              {part.added ? '+ ' : part.removed ? '− ' : '  '}
              {line}
            </span>
          )),
      )}
    </pre>
  );
}
