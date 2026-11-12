import { type ChangeEvent, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, asApiError } from '../api';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { FormError } from '../ui/field';
import { useAgents } from './agents-data';

// Import from a file: an agent another Agentome exported, or one from the catalog on
// agentome.ai. The file is read here to show what it brings before anything is made; the server
// checks it again and makes the agent with its skills.

type AgentFile = {
  format: 'agentome/agent@1' | 'agentome/agent@2';
  agent: {
    name: string;
    roleTitle: string;
    /** What the agent is told: shown before importing, as the agent will get it. */
    instructions?: string;
    skills: unknown[];
    mcpServers?: { name: string }[];
  };
  source?: { name: string; url: string; license: string };
};

type Imported = {
  agent: { id: string; name: string };
  skills: { name: string; version: number; added: boolean }[];
  missingServers: string[];
};

/** The skill's name as its SKILL.md's frontmatter gives it. */
const skillName = (skill: unknown) =>
  /^name:\s*(.+)$/m.exec((skill as { content?: string }).content ?? '')?.[1]?.trim() ?? 'skill';

async function read(file: File): Promise<AgentFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} isn't JSON. Pick the .agent.json file of an agent.`);
  }
  const candidate = parsed as Partial<AgentFile> | null;
  if (
    !candidate ||
    (candidate.format !== 'agentome/agent@1' && candidate.format !== 'agentome/agent@2') ||
    typeof candidate.agent?.name !== 'string'
  ) {
    throw new Error(`${file.name} isn't an agent file. Pick the .agent.json file of an agent.`);
  }
  return candidate as AgentFile;
}

export function ImportAgentDialog() {
  const navigate = useNavigate();
  const { reload } = useAgents();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<AgentFile>();
  const [done, setDone] = useState<Imported>();
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState(false);

  function reset(next: boolean) {
    setOpen(next);
    setFile(undefined);
    setDone(undefined);
    setFailure(undefined);
  }

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    // The same file picked again still reads.
    event.target.value = '';
    if (!chosen) return;
    setFailure(undefined);
    try {
      setFile(await read(chosen));
    } catch (caught) {
      setFile(undefined);
      setFailure(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function create() {
    if (!file) return;
    setPending(true);
    setFailure(undefined);
    try {
      const result = await api<Imported>('/api/agents/import', { body: file });
      void reload();
      // Servers it lacks are said before the agent opens; with none, it opens at once.
      if (result.missingServers.length > 0) setDone(result);
      else {
        setOpen(false);
        navigate(`/agents/${result.agent.id}`);
      }
    } catch (caught) {
      setFailure(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  const skills = file?.format === 'agentome/agent@2' ? file.agent.skills.map(skillName) : [];
  const servers = file?.agent.mcpServers?.map((server) => server.name) ?? [];

  return (
    <D.Dialog open={open} onOpenChange={reset}>
      <D.DialogTrigger asChild>
        <Button>Import</Button>
      </D.DialogTrigger>
      <D.DialogContent>
        <div className="grid gap-4">
          <D.DialogTitle>{done ? `${done.agent.name} is yours` : 'Import an agent'}</D.DialogTitle>
          {done ? (
            <>
              <D.DialogDescription>
                It uses MCP servers your library doesn't have yet:{' '}
                <span className="text-ink">{done.missingServers.join(', ')}</span>. Add them in{' '}
                <Link to="/library" className="underline underline-offset-2">
                  Library
                </Link>
                , then give them to the agent in its Tools &amp; policies.
              </D.DialogDescription>
              <D.DialogFooter>
                <Button variant="primary" onClick={() => navigate(`/agents/${done.agent.id}`)}>
                  Open the agent
                </Button>
              </D.DialogFooter>
            </>
          ) : (
            <>
              <D.DialogDescription>
                From an .agent.json file: one exported from Agentome, or one from the catalog on
                agentome.ai. Its skills join your library.
              </D.DialogDescription>
              <input
                ref={input}
                type="file"
                accept=".json,application/json"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => void pick(event)}
              />
              {file ? (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 rounded-lg border border-line p-4">
                  <dt className="text-ink-2">Agent</dt>
                  <dd className="font-medium">
                    {file.agent.name}
                    {file.agent.roleTitle && (
                      <span className="font-normal text-ink-2"> · {file.agent.roleTitle}</span>
                    )}
                  </dd>
                  <dt className="text-ink-2">Instructions</dt>
                  <dd>
                    {file.agent.instructions ? (
                      <pre
                        tabIndex={0}
                        aria-label="Instructions in the file"
                        className="max-h-40 overflow-auto rounded-md bg-desk p-2 font-mono text-small whitespace-pre-wrap text-ink-2"
                      >
                        {file.agent.instructions}
                      </pre>
                    ) : (
                      'None'
                    )}
                  </dd>
                  <dt className="text-ink-2">Skills</dt>
                  <dd>{skills.length > 0 ? skills.join(', ') : 'None'}</dd>
                  <dt className="text-ink-2">Tool policies</dt>
                  <dd className="text-ink-2">
                    The defaults: a file’s policies are not imported. Allow what you mean to in
                    Tools &amp; policies.
                  </dd>
                  {servers.length > 0 && (
                    <>
                      <dt className="text-ink-2">MCP servers</dt>
                      <dd>{servers.join(', ')}</dd>
                    </>
                  )}
                  {file.source && (
                    <>
                      <dt className="text-ink-2">From</dt>
                      <dd>
                        <a
                          href={file.source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2"
                        >
                          {file.source.name}
                        </a>
                        , {file.source.license}
                      </dd>
                    </>
                  )}
                  {file.format === 'agentome/agent@1' && (
                    <dd className="col-span-2 text-ink-2">
                      An older file: its skills and MCP servers stay behind.
                    </dd>
                  )}
                </dl>
              ) : null}
              {failure && <FormError>{failure}</FormError>}
              <D.DialogFooter>
                <Button type="button" variant="quiet" onClick={() => input.current?.click()}>
                  {file ? 'Choose another file' : 'Choose a file'}
                </Button>
                <Button variant="primary" disabled={!file || pending} onClick={() => void create()}>
                  Import agent
                </Button>
              </D.DialogFooter>
            </>
          )}
        </div>
      </D.DialogContent>
    </D.Dialog>
  );
}
