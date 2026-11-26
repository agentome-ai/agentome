import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, api, asApiError, timeAgo } from '../api';
import { useMe } from '../session';
import { LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { FormError, Field } from '../ui/field';
import { Textarea } from '../ui/input';
import { canDelete, DeleteConfirm } from './delete-confirm';
import {
  FILTER_FROM,
  ListFilter,
  ListItem,
  ListPage,
  ListPageState,
  matches,
  MoreMenu,
  Pane,
  PaneHeader,
  UsedBy,
} from './pane';
import { encodeFiles, filesOf, readFolder, sizeOf, type SkillFolder } from './skill-folder';
import type { Skill, SkillSummary } from './skills-data';

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

type Me = { id: string; role: string };
/** What the pane shows: a skill, or the form for a new one. */
type Picked = { skill: string } | { new: 'skill' };

/**
 * /skills: the skills a person may give their agents. The list on the left, yours first; the
 * one picked on the right, whole, with Edit beside its name. The pick is in the address, so a
 * link opens a skill and Back works.
 */
export function SkillsPage() {
  const me = useMe();
  const [skills, setSkills] = useState<SkillSummary[] | ApiError>();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const load = useCallback(async () => {
    try {
      setSkills((await api<{ skills: SkillSummary[] }>('/api/library/skills')).skills);
    } catch (caught) {
      setSkills(asApiError(caught));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const pick = (next?: Picked) => setParams(next ?? {});

  if (!skills || skills instanceof ApiError) {
    return <ListPageState title="Skills" what="skills" error={skills} onRetry={load} />;
  }

  const shown = skills.filter((skill) => matches(filter, `${skill.name} ${skill.description}`));
  const groups = [
    { label: 'Yours', skills: shown.filter((skill) => skill.owner?.id === me.id) },
    {
      label: 'Shared by others',
      skills: shown.filter((skill) => skill.owner && skill.owner.id !== me.id),
    },
    { label: 'From Agentome', skills: shown.filter((skill) => !skill.owner) },
  ].filter((group) => group.skills.length > 0);

  // What the address names, else the first skill of the list. A phone shows the list until
  // something is named.
  const named = params.has('skill') || params.has('new');
  const skill = params.get('new')
    ? undefined
    : named
      ? skills.find((each) => each.id === params.get('skill'))
      : groups[0]?.skills[0];
  const changed = async (id: string) => {
    await load();
    pick({ skill: id });
  };

  let pane;
  if (params.get('new') === 'skill') {
    pane = (
      <SkillPane
        key="new"
        id="new"
        me={me}
        onBack={() => pick()}
        onChanged={changed}
        onDeleted={load}
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
        onChanged={changed}
        onDeleted={async () => {
          pick();
          await load();
        }}
      />
    );
  } else {
    pane = (
      <Pane label="Skills" back="Skills" onBack={() => pick()}>
        <p className="text-ink-3">
          {named
            ? 'This skill is not here any more. Pick another from the list.'
            : 'No skills yet. Add one, then give it to your agents from their Skills section.'}
        </p>
      </Pane>
    );
  }

  return (
    <ListPage
      title="Skills"
      named={named}
      head={
        <>
          <span className="text-small text-ink-3 tabular-nums">
            {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
          </span>
          <Button size="sm" variant="quiet" onClick={() => pick({ new: 'skill' })}>
            Add a skill
          </Button>
        </>
      }
      list={
        <>
          {skills.length > FILTER_FROM && (
            <div className="px-4 pb-2">
              <ListFilter label="Filter skills" value={filter} onChange={setFilter} />
            </div>
          )}
          {skills.length === 0 && (
            <p className="px-4 pb-2 text-small text-ink-3">
              A skill is a SKILL.md that tells an agent how to do one kind of work.
            </p>
          )}
          {skills.length > 0 && shown.length === 0 && (
            <p className="px-4 pb-2 text-small text-ink-3">
              No skill has “{filter.trim()}” in its name or description.
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
        </>
      }
    >
      {pane}
    </ListPage>
  );
}

/** The files a version brings beside its SKILL.md: their paths, which the agent reads them by. */
function SkillFiles({ skill }: { skill: Skill }) {
  const { files } = skill;
  return (
    <section aria-labelledby="skill-files" className="grid gap-2">
      <h3 id="skill-files" className="text-section">
        Files
      </h3>
      <p className="text-small text-ink-3">
        {filesOf(skill.fileCount, skill.fileBytes)}, beside the SKILL.md in each run, read only. The
        agent reads them when the skill says to.
      </p>
      <ul
        tabIndex={0}
        aria-label="Files of the skill"
        className="max-h-80 overflow-auto rounded-lg border border-line font-mono text-small"
      >
        {files.map((file) => (
          <li
            key={file.path}
            className="flex justify-between gap-4 border-b border-line px-3 py-1.5 last:border-b-0"
          >
            <span className="min-w-0 truncate" title={file.path}>
              {file.path}
            </span>
            <span className="shrink-0 text-ink-3">{sizeOf(file.size)}</span>
          </li>
        ))}
      </ul>
    </section>
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
  /** A folder picked for the new version: its files replace the ones the skill had. */
  const [folder, setFolder] = useState<SkillFolder>();
  const folderInput = useRef<HTMLInputElement>(null);
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
      const files = body && folder ? { files: await encodeFiles(folder) } : {};
      const saved = await api<Skill>(url, { method: 'POST', body: body && { ...body, ...files } });
      setEditing(false);
      setFolder(undefined);
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

  async function pickFolder(list: FileList | null) {
    const read = await readFolder([...(list ?? [])]);
    if (folderInput.current) folderInput.current.value = '';
    if ('error' in read) return setError(read.error);
    setError(undefined);
    setFolder(read);
    if (read.skillMd !== undefined) setText(read.skillMd);
  }
  const kept = !adding && !folder && loaded && loaded.fileCount > 0;
  const filesHint = folder
    ? `${filesOf(folder.files.length, folder.bytes)}${folder.skillMd === undefined ? '' : ' and its SKILL.md'}${
        folder.hidden > 0 ? `; ${folder.hidden} hidden left out` : ''
      }.${adding ? '' : ' They replace the files of this version.'}`
    : kept
      ? `Without a new folder, this version keeps the ${filesOf(loaded.fileCount, loaded.fileBytes)} of version ${loaded.version}.`
      : 'A folder with a SKILL.md and the files it reads beside it, such as references and scripts. Up to 3,000 files and 25 MB.';
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
      <div className="grid gap-2" role="group" aria-label="Files">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => folderInput.current?.click()}>
            {folder ? 'Choose another folder' : 'Upload a skill folder'}
          </Button>
          {folder && (
            <Button variant="quiet" onClick={() => setFolder(undefined)}>
              Remove the files
            </Button>
          )}
        </div>
        <p className="text-small text-ink-3">{filesHint}</p>
        <input
          ref={folderInput}
          type="file"
          multiple
          // The browser reads a whole folder, each file with its path in it.
          {...{ webkitdirectory: '' }}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void pickFolder(event.target.files)}
        />
      </div>
      {error && <FormError>{error}</FormError>}
      <div className="flex justify-end gap-2">
        <Button
          variant="quiet"
          onClick={() => {
            setFolder(undefined);
            setError(undefined);
            if (adding) props.onBack();
            else setEditing(false);
          }}
        >
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
        back="Skills"
        onBack={props.onBack}
        header={
          <PaneHeader
            title="Add a skill"
            about="Paste a SKILL.md, or upload the skill's folder. Only you can use it until an admin shares it."
          />
        }
      >
        {form}
      </Pane>
    );
  }
  if (!shown) {
    return (
      <Pane label="Skill" back="Skills" onBack={props.onBack}>
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
      back="Skills"
      onBack={props.onBack}
      header={
        <PaneHeader
          title={shown.name}
          about={shown.description}
          facts={[
            ['Version', String(shown.version)],
            ['Added', `${timeAgo(shown.createdAt)} by ${by}`],
            ['Shared with', shown.visibility === 'org' ? 'everyone' : 'only its author'],
            ...(shown.fileCount > 0
              ? [['Files', filesOf(shown.fileCount, shown.fileBytes)] as const]
              : []),
            ['Used by', <UsedBy url={`/api/library/skills/${shown.id}/agents`} />],
          ]}
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
                <Markdown className="max-w-[80ch]">
                  {loaded.content.replace(/^---[\s\S]*?---\s*/, '')}
                </Markdown>
              </Suspense>
            )}
          </div>
          {loaded && loaded.files.length > 0 && <SkillFiles skill={loaded} />}
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
