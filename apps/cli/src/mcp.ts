import { createInterface } from 'node:readline';
import { Refusal } from './system.js';

// `agentome mcp`: Agentome's management MCP over stdio, for a client that starts a program rather
// than calling a URL with a header (Claude Desktop's config, some editors). Each JSON-RPC message
// on stdin goes to the server's /mcp/manage with the person's token, and what it answers comes back
// on stdout, a message a line. The server keeps no sessions, so nothing is kept here either.

export interface Bridge {
  /** The server's address, or its /mcp/manage. */
  url: string;
  token: string;
  fetch: typeof fetch;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Where the bridge says what went wrong: stderr, since stdout is the protocol. */
  log: (line: string) => void;
}

type Message = { id?: string | number | null; method?: string };

/** The /mcp/manage of an address given as the server or as the endpoint itself. */
export function manageUrl(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Refusal(`AGENTOME_URL is not an address: ${address}`);
  }
  // The token goes with every message: in the clear only to this machine.
  const here =
    ['localhost', '[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && here)) {
    throw new Refusal('AGENTOME_URL starts with https:// (or http:// on this machine)');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/mcp/manage') ? path : `${path}/mcp/manage`;
  return url.toString();
}

/** The data of each event of a server-sent event stream, in order. */
export function sseData(text: string): string[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n'),
    )
    .filter((data) => data !== '');
}

/** Runs until stdin ends and every answer is written. */
export async function bridge(options: Bridge): Promise<void> {
  const endpoint = manageUrl(options.url);
  const write = (message: unknown) => options.output.write(`${JSON.stringify(message)}\n`);
  // A request the server could not answer still gets an answer, so the client does not wait on it.
  const fail = (messages: Message[], text: string) => {
    options.log(`agentome mcp: ${text}`);
    for (const message of messages) {
      if (message.id === undefined || message.id === null || !message.method) continue;
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } });
    }
  };

  const send = async (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Message[];
    let answer: Response;
    try {
      answer = await options.fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: line,
      });
    } catch (error) {
      fail(messages, `cannot reach ${endpoint}: ${(error as Error).message}`);
      return;
    }
    const body = await answer.text();
    if (!answer.ok) {
      // Agentome's own refusal, such as a token that expired, says why in words.
      let why = `${answer.status} ${answer.statusText}`.trim();
      try {
        const refusal = JSON.parse(body) as { error?: { message?: string } };
        if (refusal.error?.message) why = refusal.error.message;
      } catch {
        // Not Agentome's answer (a proxy's page): the status says enough.
      }
      fail(messages, why);
      return;
    }
    const type = answer.headers.get('content-type') ?? '';
    const parts = type.includes('text/event-stream') ? sseData(body) : body.trim() ? [body] : [];
    for (const part of parts) {
      try {
        const value = JSON.parse(part) as unknown;
        for (const item of Array.isArray(value) ? value : [value]) write(item);
      } catch {
        fail(messages, 'the server answered something that is not JSON-RPC');
      }
    }
  };

  // Messages go out as they come: a long tool call does not hold back a ping or a cancel.
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const sent = send(line).finally(() => pending.delete(sent));
    pending.add(sent);
  }
  await Promise.all(pending);
}
