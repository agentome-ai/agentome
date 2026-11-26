import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, api, asApiError } from '../api';
import { useMe } from '../session';
import { Button } from '../ui/button';
import { FormError } from '../ui/field';
import { AddServerDialog, ServerPane, serverNote } from './mcp-servers';
import { FILTER_FROM, ListFilter, ListItem, ListPage, ListPageState, matches, Pane } from './pane';
import type { McpServer } from './skills-data';

/**
 * /mcp-servers: the remote MCP servers a person may give their agents, laid out as Skills is.
 * The pick is in the address; a server's sign-in comes back here with how it went.
 */
export function ServersPage() {
  const me = useMe();
  const [servers, setServers] = useState<McpServer[] | ApiError>();
  const [adding, setAdding] = useState(false);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const load = useCallback(async () => {
    try {
      setServers((await api<{ servers: McpServer[] }>('/api/library/mcp')).servers);
    } catch (caught) {
      setServers(asApiError(caught));
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

  const pick = (id?: string) => setParams(id ? { server: id } : {});

  if (!servers || servers instanceof ApiError) {
    return <ListPageState title="MCP servers" what="MCP servers" error={servers} onRetry={load} />;
  }

  const shown = servers.filter((each) => matches(filter, `${each.name} ${each.description}`));
  // What the address names; without a name, the server the browser has just signed in to, or
  // the first of the list. A phone shows the list until something is named.
  const named = params.has('server');
  const server = named
    ? servers.find((each) => each.id === params.get('server'))
    : (servers.find((each) => each.name === notice?.signedIn) ?? shown[0]);

  return (
    <>
      <ListPage
        title="MCP servers"
        named={named}
        head={
          <>
            <span className="text-small text-ink-3 tabular-nums">
              {servers.length} {servers.length === 1 ? 'server' : 'servers'}
            </span>
            <Button size="sm" variant="quiet" onClick={() => setAdding(true)}>
              Add an MCP server
            </Button>
          </>
        }
        list={
          <>
            {servers.length > FILTER_FROM && (
              <div className="px-4 pb-2">
                <ListFilter label="Filter servers" value={filter} onChange={setFilter} />
              </div>
            )}
            {servers.length === 0 ? (
              <p className="px-4 pb-2 text-small text-ink-3">
                An MCP server gives agents more tools, such as your tracker's. Its secret stays on
                Agentome.
              </p>
            ) : shown.length === 0 ? (
              <p className="px-4 pb-2 text-small text-ink-3">
                No server has “{filter.trim()}” in its name or description.
              </p>
            ) : (
              <ul
                aria-label="MCP servers"
                className="grid grid-cols-[minmax(0,1fr)] border-t border-line"
              >
                {shown.map((each) => (
                  <ListItem
                    key={each.id}
                    name={each.name}
                    note={serverNote(each)}
                    current={each.id === server?.id}
                    onPick={() => pick(each.id)}
                  />
                ))}
              </ul>
            )}
          </>
        }
      >
        {notice?.error && (
          <div className="max-w-260 px-4 pt-4 md:px-10">
            <FormError>Couldn't sign in: {notice.error}</FormError>
          </div>
        )}
        {server ? (
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
        ) : (
          <Pane label="MCP servers" back="MCP servers" onBack={() => pick()}>
            <p className="text-ink-3">
              {named
                ? 'This server is not here any more. Pick another from the list.'
                : 'No MCP servers yet. Add a remote one, then give it to an agent from its Tools & policies.'}
            </p>
          </Pane>
        )}
      </ListPage>
      {adding && (
        <AddServerDialog
          onClose={() => setAdding(false)}
          onAdded={async (id) => {
            await load();
            pick(id);
          }}
        />
      )}
    </>
  );
}
