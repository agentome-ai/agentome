import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, asApiError } from '../api';
import type { McpServer } from '../library/skills-data';
import { Chip } from '../ui/chip';
import { Combobox } from '../ui/combobox';
import { FormError } from '../ui/field';
import { textLink } from '../ui/properties';
import type { Agent } from './agents-data';

/**
 * The library's MCP servers the agent may call, above its policies: a server's tools join the
 * list below under its name, asking the owner until a policy says otherwise. Saves at once.
 */
export function McpServersPicker(props: { agent: Agent; onSaved: (agent: Agent) => void }) {
  const { agent } = props;
  const [library, setLibrary] = useState<McpServer[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    api<{ servers: McpServer[] }>('/api/library/mcp').then(
      ({ servers }) => setLibrary(servers),
      (caught: unknown) => setError(asApiError(caught).message),
    );
  }, []);

  async function save(ids: string[]) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/agents/${agent.id}/mcp`, { method: 'PUT', body: { servers: ids } });
      // The servers' tools come with the agent, each with its policy.
      props.onSaved(await api<Agent>(`/api/agents/${agent.id}`));
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  const ids = agent.mcpServers.map((server) => server.id);
  const options = (library ?? [])
    .filter((server) => !agent.mcpServers.some((mine) => mine.name === server.name))
    .map((server) => ({ value: server.id, label: server.name }));

  return (
    <div className="mb-6 grid gap-3">
      <p className="text-small text-ink-2">
        MCP servers from the{' '}
        <Link to="/library" className={textLink}>
          library
        </Link>{' '}
        give the agent more tools. The server&apos;s secret stays on Agentome.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {agent.mcpServers.length > 0 && (
          <ul aria-label="MCP servers of this agent" className="flex flex-wrap gap-2">
            {agent.mcpServers.map((server) => (
              <li key={server.id}>
                <Chip className="pr-1">
                  <code>{server.name}</code>
                  {server.privateTo && <span className="text-ink-3">private</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${server.name}`}
                    onClick={() => void save(ids.filter((id) => id !== server.id))}
                    className="rounded-sm p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </Chip>
              </li>
            ))}
          </ul>
        )}
        {library && (
          <Combobox
            value={null}
            options={options}
            trigger="action"
            placeholder={pending ? 'Saving…' : 'Add an MCP server'}
            searchPlaceholder="Search MCP servers"
            emptyText={
              library.length
                ? 'The agent has every server of the library'
                : 'No MCP servers in the library yet'
            }
            onValueChange={(id) => void save([...ids, id])}
          />
        )}
      </div>
      {error && <FormError>{error}</FormError>}
    </div>
  );
}
