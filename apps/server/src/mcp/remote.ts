import { span, spanUrl } from '../logs/span.js';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type CallToolResult, McpError } from '@modelcontextprotocol/sdk/types.js';
import packageJson from '../../package.json' with { type: 'json' };

// The library's MCP servers: remote, over streamable HTTP, and the gateway is their
// only client, with each server's secret, which never leaves the platform. A person names the
// address, so the gateway refuses the ones that are this machine or link-local (a cloud's
// metadata service) and follows no redirect; a company's own network stays reachable, since
// that is where its MCP servers live.

/** Where a server answers, and the Authorization header the gateway sends it, if any. */
export interface RemoteServer {
  readonly url: string;
  readonly authorization: string | null;
}

/** A tool as the server lists it, kept so a run sees it without asking the server first. */
export interface RemoteTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Why a server could not be used, in words a person or an agent can act on. */
export class RemoteError extends Error {}

/** The server answered 401: the header or token it was sent no longer lets anyone in. */
export class RemoteRefused extends RemoteError {}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

// Each forbidden IPv4 range also in the forms IPv6 can carry it: mapped (::ffff:), compatible
// (::/96, all of it) and NAT64 (64:ff9b::). BlockList compares addresses, not spellings, so
// [::ffff:7f00:1], which the URL parser makes of [::ffff:127.0.0.1], is caught too.
const FORBIDDEN = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 3],
] as const) {
  FORBIDDEN.addSubnet(address, prefix, 'ipv4');
  FORBIDDEN.addSubnet(`::ffff:${address}`, 96 + prefix, 'ipv6');
  FORBIDDEN.addSubnet(`64:ff9b::${address}`, 96 + prefix, 'ipv6');
}
FORBIDDEN.addSubnet('::', 96, 'ipv6');
FORBIDDEN.addSubnet('fe80::', 10, 'ipv6');
FORBIDDEN.addSubnet('ff00::', 8, 'ipv6');

const forbidden = (address: string) =>
  FORBIDDEN.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');

/** fetch for a library server: no address of this machine or link-local, no redirect. */
export const guardedFetch: FetchLike = async (url, init) => {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((found) => found.address);
  if (addresses.some(forbidden)) {
    throw new RemoteError(`${target.host} is this machine or a link-local address`);
  }
  const response = await span(
    `mcp ${init?.method ?? 'GET'} ${spanUrl(url)}`,
    () => fetch(url, { ...init, redirect: 'manual' }),
    (answer) => ({ status: answer.status }),
  );
  if (response.status >= 300 && response.status < 400) {
    throw new RemoteError(
      `${target.host} answered with a redirect, which the gateway does not follow`,
    );
  }
  return response;
};

/**
 * How a server failed, never what it said: anyone may name any address, and the body of a
 * service on the company network that is not an MCP server is not theirs to read. A real MCP
 * server's own error, in JSON-RPC, is kept.
 */
export function failureOf(error: unknown): string {
  if (error instanceof McpError) return error.message.slice(0, 300);
  if (error instanceof StreamableHTTPError) {
    return error.code !== undefined && error.code > 0
      ? `it answered HTTP ${error.code}`
      : 'it answered with something other than MCP';
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause instanceof Error && 'code' in cause ? String(cause.code) : '';
  return /^E[A-Z_]+$/.test(code) ? `no connection (${code})` : 'no answer it could read';
}

async function connected<T>(
  server: RemoteServer,
  fetchImpl: FetchLike,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const host = new URL(server.url).host;
  const client = new Client({ name: 'agentome-gateway', version: packageJson.version });
  const headers: Record<string, string> = server.authorization
    ? { authorization: server.authorization }
    : {};
  // The SDK reports a 401 in words that differ by version; the status itself is plain.
  let refused = false;
  const watched: FetchLike = async (url, init) => {
    const response = await fetchImpl(url, init);
    if (response.status === 401) refused = true;
    return response;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers },
        fetch: watched,
      }),
    );
    return await use(client);
  } catch (error) {
    if (error instanceof RemoteError) throw error;
    if (refused)
      throw new RemoteRefused(`${host} refused the authorization it was sent (401)`, {
        cause: error,
      });
    throw new RemoteError(`${host} did not answer as an MCP server: ${failureOf(error)}`, {
      cause: error,
    });
  } finally {
    await client.close();
  }
}

/** Every tool the server lists, page by page, up to a ceiling. */
export function listRemoteTools(server: RemoteServer, fetchImpl: FetchLike = guardedFetch) {
  return connected(server, fetchImpl, async (client) => {
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of listed.tools) {
        tools.push({
          name: tool.name,
          title: tool.title ?? tool.annotations?.title ?? tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        });
      }
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return tools;
  });
}

/** One call on the server, its result as the server gave it. */
export function callRemoteTool(
  server: RemoteServer,
  name: string,
  args: Record<string, unknown>,
  fetchImpl: FetchLike = guardedFetch,
) {
  return connected(
    server,
    fetchImpl,
    async (client) => (await client.callTool({ name, arguments: args })) as CallToolResult,
  );
}
