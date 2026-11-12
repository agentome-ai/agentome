import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, api, asApiError, timeAgo } from '../api';
import { ApiErrorState, useMe } from '../session';
import { ContextFacts, frame, PageHeader, split } from '../shell/page-header';
import { LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Textarea } from '../ui/input';
import { canDelete, DeleteConfirm } from './delete-confirm';
import { AddServerDialog, ServerPane, serverNote } from './mcp-servers';
import { ListItem, MoreMenu, Pane, PaneHeader, UsedBy } from './pane';
import type { McpServer, Skill, SkillSummary } from './skills-data';

const Markdown = lazy(() =>
  import('../ui/markdown').then(({ Markdown }) => ({ default: Markdown })),
);

const template = `---
name: release-notes
description: Writes release notes from merged pull requests, in the house style
---

# Release notes

1. Read the merged pull requests since the last tag.
2. Group them as Added, Changed and Fixed.
`;

type Library = { skills: SkillSummary[]; servers: McpServer[] };
type Me = { id: string; role: string };
/** What the pane shows: a skill, a server, or the form for a new skill. */
type Picked = { skill: string } | { server: string } | { new: 'skill' };

/**
 * /library: the skills and MCP servers a person may give their agents, as Approvals is laid out.
 * The list on the left, yours first; the one picked on the right, whole, with
 * Edit beside its name. The pick is in the address, so a link opens an item and Back works. On a
 * phone the list is the page and an item opens over it.
 */
export function LibraryPage() {
  const me = useMe();
  const [library, setLibrary] = useState<Library | ApiError>();
  const [addingServer, setAddingServer] = useState(false);
  const [params, setParams] = useSearchParams();
  const load = useCallback(async () => {
    try {
      const [{ skills }, { servers }] = await Promise.all([
        api<{ skills: SkillSummary[] }>('/api/library/skills'),
        api<{ servers: McpServer[] }>('/api/library/mcp'),
      ]);
      setLibrary({ skills, servers });
    } catch (caught) {
      setLibrary(asApiError(caught));
    }
  }, []);
  useEffect(() => void load(), [load]);

  // How an OAuth sign-in went: the server's callback comes back with it in the address, said
  // once and then taken out of the address.
  const [notice, setNotice] = useState<{ signedIn?: string; error?: string }>();
  useEffect(() => {
    const signedIn = params.get('mcpSignedIn') ?? undefined;
    const error = params.get('mcpError') ?? undefined;
    if (!signedIn && !error) return;
    setNotice({ signedIn, error });
    const next = new URLSearchParams(params);
    next.delete('mcpSignedIn');
    next.delete('mcpError');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const pick = (next?: Picked) => setParams(next ?? {});

  if (!library || library instanceof ApiError) {
    return (
      <>
        <PageHeader title="Library" />
        <div className={cn(frame.wide, 'pt-6')}>
          {library ? (
            <ApiErrorState title="Couldn't load the library" error={library} onRetry={load} />
          ) : (
            <LoadingState label="Loading the library" />
          )}
        </div>
      </>
    );
  }

  const { skills, servers } = library;
  const groups = [
    { label: 'Yours', skills: skills.filter((skill) => skill.owner?.id === me.id) },
    {
      label: 'Shared by others',
      skills: skills.filter((skill) => skill.owner && skill.owner.id !== me.id),
    },
    { label: 'From Agentome', skills: skills.filter((skill) => !skill.owner) },
  ].filter((group) => group.skills.length > 0);

  // What the address names; without a name, the server the browser has just signed in to, or the
  // first item of the list. A phone shows the list until something is named.
  const named = params.has('skill') || params.has('server') || params.has('new');
  const justSignedIn = servers.find((server) => server.name === notice?.signedIn);
  const server = named
    ? servers.find((each) => each.id === params.get('server'))
    : (justSignedIn ?? (skills.length === 0 ? servers[0] : undefined));
  const skill = params.get('new')
    ? undefined
    : named
      ? skills.find((each) => each.id === params.get('skill'))
      : server
        ? undefined
        : groups[0]?.skills[0];

  let pane;
  if (params.get('new') === 'skill') {
    pane = (
      <SkillPane
        key="new"
        id="new"
        me={me}
        onBack={() => pick()}
        onChanged={async (id) => {
          await load();
          pick({ skill: id });
        }}
        onDeleted={load}
      />
    );
  } else if (server) {
    pane = (
      <ServerPane
        key={server.id}
        server={server}
        me={me}
        signedIn={notice?.signedIn === server.name}
        onBack={() => pick()}
        onChanged={load}
        onDeleted={async () => {
          pick();
          await load();
        }}
      />
    );
  } else if (skill) {
    pane = (
      <SkillPane
        key={skill.id}
        id={skill.id}
        summary={skill}
        me={me}
        onBack={() => pick()}
        onChanged={async (id) => {
          await load();
          pick({ skill: id });
        }}
        onDeleted={async () => {
          pick();
          await load();
        }}
      />
    );
  } else {
    pane = (
      <Pane label="Library" onBack={() => pick()}>
        <p className="text-ink-3">
          {named
            ? 'This item is not in the library any more. Pick another from the list.'
            : 'Nothing here yet. Add a skill or an MCP server, then give it to your agents.'}
        </p>
      </Pane>
    );
  }

  const heading = 'flex items-center justify-between gap-2 px-4 pt-3.5 pb-1.5';
  return (
    <>
      <PageHeader title="Library" />
      <div className={split.page}>
        <nav aria-label="Library" className={cn(split.list, 'pb-6', named && 'max-md:hidden')}>
          <div className={heading}>
            <h2 className="text-section">Skills</h2>
            <Button size="sm" variant="quiet" onClick={() => pick({ new: 'skill' })}>
              Add a skill
            </Button>
          </div>
          {skills.length === 0 && (
            <p className="px-4 pb-2 text-small text-ink-3">
              No skills yet. A skill is a SKILL.md that tells an agent how to do one kind of work.
            </p>
          )}
          {groups.map((group) => (
            <section key={group.label} aria-label={`${group.label}: skills`}>
              <h3 className="px-4 pt-2 pb-1 text-small text-ink-3">{group.label}</h3>
              <ul className="grid grid-cols-[minmax(0,1fr)] border-t border-line">
                {group.skills.map((each) => (
                  <ListItem
                    key={each.id}
                    name={each.name}
                    note={each.description}
                    current={each.id === skill?.id}
                    onPick={() => pick({ skill: each.id })}
                  />
                ))}
              </ul>
            </section>
          ))}
          <div className={cn(heading, 'mt-4')}>
            <h2 className="text-section">MCP servers</h2>
            <Button size="sm" variant="quiet" onClick={() => setAddingServer(true)}>
              Add an MCP server
            </Button>
          </div>
          {servers.length === 0 ? (
            <p className="px-4 pb-2 text-small text-ink-3">
              No MCP servers yet. Add a remote one, such as your tracker's, and give it to an agent
              from its Tools &amp; policies.
            </p>
          ) : (
            <ul
              aria-label="MCP servers"
              className="grid grid-cols-[minmax(0,1fr)] border-t border-line"
            >
              {servers.map((each) => (
                <ListItem
                  key={each.id}
                  name={each.name}
                  note={serverNote(each)}
                  current={each.id === server?.id}
                  onPick={() => pick({ server: each.id })}
                />
              ))}
            </ul>
          )}
        </nav>
        <div className={cn(split.item, !named && 'max-md:hidden')}>
          {notice?.error && (
            <div className="max-w-190 px-4 pt-4 md:px-10">
              <FormError>Couldn't sign in: {notice.error}</FormError>
            </div>
          )}
          {pane}
        </div>
      </div>
      {addingServer && (
        <AddServerDialog
          onClose={() => setAddingServer(false)}
          onAdded={async (id) => {
            await load();
            pick({ server: id });
          }}
        />
      )}
    </>
  );
}

/**
 * One skill, whole: its SKILL.md as it reads, Edit for its author (which saves a new version),
 * Share for an admin and Delete in the menu. With `new` it is the form for a skill to add.
 */
function SkillPane(props: {
  id: string | 'new';
  /** What the list knows of the skill: its header shows at once, its text once it is read. */
  summary?: SkillSummary;
  me: Me;
  onBack: () => void;
  onChanged: (id: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const { id, me } = props;
  const adding = id === 'new';
  const [skill, setSkill] = useState<Skill | ApiError>();
  const [editing, setEditing] = useState(adding);
  const [deleting, setDeleting] = useState(false);
  const [text, setText] = useState(adding ? template : '');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const read = useCallback(
    () =>
      api<Skill>(`/api/library/skills/${id}`).then(setSkill, (caught: unknown) =>
        setSkill(asApiError(caught)),
      ),
    [id],
  );
  useEffect(() => {
    if (!adding) void read();
  }, [adding, read]);

  async function send(url: string, body?: object) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const saved = await api<Skill>(url, { method: 'POST', body });
      setEditing(false);
      // A new version is a new item, which the page picks; a shared skill is this one, read again.
      if (saved.id === id) await read();
      await props.onChanged(saved.id);
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  const loaded = skill && !(skill instanceof ApiError) ? skill : undefined;
  const shown = loaded ?? props.summary;
  const mine = shown?.owner?.id === me.id;
  const form = (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send(adding ? '/api/library/skills' : `/api/library/skills/${id}/versions`, {
          content: text,
        });
      }}
    >
      <Field
        label="SKILL.md"
        hint={
          adding
            ? 'Its frontmatter names the skill and says what it is for.'
            : 'Keep the name to save a new version; a new name is a new skill.'
        }
      >
        {(control) => (
          <Textarea
            {...control}
            rows={22}
            className="font-mono text-ui"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>
      {error && <FormError>{error}</FormError>}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={() => (adding ? props.onBack() : setEditing(false))}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !text.trim()}>
          {adding ? 'Add skill' : 'Save as a new version'}
        </Button>
      </div>
    </form>
  );

  if (adding) {
    return (
      <Pane
        label="Add a skill"
        onBack={props.onBack}
        header={
          <PaneHeader
            title="Add a skill"
            about="Paste a SKILL.md. Only you can use it until an admin shares it."
          />
        }
      >
        {form}
      </Pane>
    );
  }
  if (!shown) {
    return (
      <Pane label="Skill" onBack={props.onBack}>
        {skill instanceof ApiError ? (
          <FormError>{skill.message}</FormError>
        ) : (
          <LoadingState label="Loading the skill" />
        )}
      </Pane>
    );
  }
  const by = mine ? 'you' : (shown.owner?.name ?? 'Agentome');
  return (
    <Pane
      label={shown.name}
      onBack={props.onBack}
      context={
        <>
          <ContextFacts
            facts={[
              ['Version', String(shown.version)],
              ['Added', `${timeAgo(shown.createdAt)} by ${by}`],
              ['Shared with', shown.visibility === 'org' ? 'Everyone' : 'Only its author'],
            ]}
          />
          <UsedBy url={`/api/library/skills/${shown.id}/agents`} from="its Skills section" />
        </>
      }
      header={
        <PaneHeader
          title={shown.name}
          about={shown.description}
          note={`Version ${shown.version}, added ${timeAgo(shown.createdAt)} by ${by}. ${
            shown.visibility === 'org'
              ? 'Everyone can give it to their agents.'
              : 'Only its author can use it until an admin shares it.'
          }`}
          actions={
            !editing && (
              <>
                {mine && (
                  <Button
                    disabled={!loaded}
                    onClick={() => {
                      setText(loaded?.content ?? '');
                      setError(undefined);
                      setEditing(true);
                    }}
                  >
                    Edit
                  </Button>
                )}
                <MoreMenu
                  name={shown.name}
                  items={[
                    me.role === 'admin' &&
                      shown.visibility === 'private' && {
                        label: 'Share with everyone',
                        onSelect: () => void send(`/api/library/skills/${shown.id}/share`),
                      },
                    canDelete(shown, me) && {
                      label: 'Delete',
                      danger: true,
                      onSelect: () => setDeleting(true),
                    },
                  ]}
                />
              </>
            )
          }
        />
      }
    >
      {editing ? (
        form
      ) : (
        <>
          {error && <FormError>{error}</FormError>}
          {skill instanceof ApiError && <FormError>{skill.message}</FormError>}
          {/* The document set apart from what the page says about it, as Approvals sets apart
              what an agent wrote. */}
          <div className="rounded-xl border border-line bg-raised px-5 py-4">
            <p className="mb-3 font-mono text-small text-ink-3">SKILL.md</p>
            {loaded && (
              <Suspense>
                <Markdown>{loaded.content.replace(/^---[\s\S]*?---\s*/, '')}</Markdown>
              </Suspense>
            )}
          </div>
        </>
      )}
      <D.Dialog open={deleting} onOpenChange={setDeleting}>
        <D.DialogContent>
          <DeleteConfirm
            kind="skill"
            name={shown.name}
            url={`/api/library/skills/${shown.id}`}
            onCancel={() => setDeleting(false)}
            onDeleted={props.onDeleted}
          />
        </D.DialogContent>
      </D.Dialog>
    </Pane>
  );
}
