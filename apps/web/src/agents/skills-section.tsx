import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, asApiError } from '../api';
import type { AgentSkill, SkillSummary } from '../library/skills-data';
import { Button } from '../ui/button';
import { Chip } from '../ui/chip';
import { Combobox } from '../ui/combobox';
import { FormError } from '../ui/field';
import { textLink } from '../ui/properties';

/**
 * The editor's Skills section: the skills the agent has, each at the version it was given, from
 * the library. A change saves at once, as a policy does: it applies to the agent's next run.
 */
export function SkillsSection(props: {
  agentId: string;
  skills: AgentSkill[];
  onSaved: (skills: AgentSkill[]) => void;
}) {
  const { agentId, skills } = props;
  const [library, setLibrary] = useState<SkillSummary[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    api<{ skills: SkillSummary[] }>('/api/library/skills').then(
      ({ skills: all }) => setLibrary(all),
      (caught: unknown) => setError(asApiError(caught).message),
    );
  }, []);

  async function save(ids: string[]) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const saved = await api<{ skills: SkillSummary[] }>(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        body: { skills: ids },
      });
      props.onSaved(
        saved.skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          version: String(skill.version),
          privateTo: skill.visibility === 'private' ? skill.owner?.name : undefined,
        })),
      );
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  const ids = skills.map((skill) => skill.id);
  const newest = (name: string) => library?.find((skill) => skill.name === name);
  const options = (library ?? [])
    .filter((skill) => !skills.some((mine) => mine.name === skill.name))
    .map((skill) => ({ value: skill.id, label: `${skill.name}, version ${skill.version}` }));

  return (
    <div className="grid gap-3">
      {skills.length === 0 ? (
        <p className="text-ink-2">
          No skills yet. Give the agent one from the{' '}
          <Link to="/library" className={textLink}>
            library
          </Link>
          : it reads the skill when a task calls for it.
        </p>
      ) : (
        <ul aria-label="Skills of this agent" className="flex flex-wrap gap-2">
          {skills.map((skill) => {
            const latest = newest(skill.name);
            const behind = latest && String(latest.version) !== skill.version ? latest : undefined;
            return (
              <li key={skill.id} className="flex items-center gap-1.5">
                <Chip className="pr-1">
                  <code>{skill.name}</code>
                  <span className="text-ink-3">v{skill.version}</span>
                  {skill.privateTo && <span className="text-ink-3">private</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${skill.name}`}
                    onClick={() => void save(ids.filter((id) => id !== skill.id))}
                    className="rounded-sm p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </Chip>
                {behind && (
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => void save(ids.map((id) => (id === skill.id ? behind.id : id)))}
                  >
                    Move to version {behind.version}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {library && (
        <Combobox
          value={null}
          options={options}
          trigger="action"
          placeholder={pending ? 'Saving…' : 'Add a skill'}
          searchPlaceholder="Search skills"
          emptyText={
            library.length ? 'The agent has every skill of the library' : 'The library is empty'
          }
          onValueChange={(id) => void save([...ids, id])}
        />
      )}
      {error && <FormError>{error}</FormError>}
    </div>
  );
}
