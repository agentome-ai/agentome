import { asc, type Db, eq, modelConnections } from '@agentome/db';
import type { ModelConnectionKind } from '@agentome/shared';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '../connections/crypto.js';
import { AppError } from '../errors.js';
import { type FetchLike, guardedFetch } from '../mcp/remote.js';

// Model connections: where a server run's model comes from — Anthropic or OpenAI by an
// API key, or a gateway such as LiteLLM or OpenRouter — set up by an admin, as in Open WebUI. The key is
// encrypted as code-host tokens are and never answered. A check reads the connection's models,
// which is also how a wrong key or address shows.

/** Where each vendor lives unless the admin says otherwise; a gateway has no address of its own. */
export const DEFAULT_URL: Partial<Record<ModelConnectionKind, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

/** The address in front of /v1: `https://openrouter.ai/api/v1/` and `…/api` are the same one. */
export const BaseUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((url) => url.replace(/\/+$/, '').replace(/\/v1$/, ''));
export const ApiKey = z.string().trim().min(1, 'Paste the API key').max(4096);
export const Name = z.string().trim().min(1, 'Name the connection').max(100);

/** The engine that can run a model: Claude Code runs Claude models only. */
export const engineOf = (model: string): 'claude-code' | 'codex' =>
  /claude/i.test(model) ? 'claude-code' : 'codex';

const ModelList = z.object({ data: z.array(z.object({ id: z.string() })) });

/** Reads a connection's models; an answer that is not a model list says what went wrong. */
export async function readModels(
  kind: ModelConnectionKind,
  baseUrl: string,
  key: string,
  fetchImpl: FetchLike = guardedFetch,
): Promise<string[]> {
  // Anthropic takes its key in its own header; OpenAI and the gateways as a bearer token.
  const headers: Record<string, string> =
    kind === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${key}` };
  const host = new URL(baseUrl).host;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/models?limit=1000`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    throw new AppError('connection_unreachable', `${host} did not answer: ${said}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      'connection_unauthorized',
      `${host} refused the key. Check it and paste it again.`,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ModelList.safeParse(body);
  if (!response.ok || !parsed.success) {
    throw new AppError(
      'connection_unreachable',
      `${host} answered ${response.status} without a list of models: is this the address in front of /v1?`,
    );
  }
  return [...new Set(parsed.data.data.map((model) => model.id))].sort();
}

type Row = typeof modelConnections.$inferSelect;

export function viewOf(row: Row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    models: row.models.map((id) => ({ id, engine: engineOf(id) })),
    checkedAt: row.checkedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listModelConnections(db: Db) {
  const rows = await db.select().from(modelConnections).orderBy(asc(modelConnections.name));
  return rows.map(viewOf);
}

async function rowFor(db: Db, id: string): Promise<Row> {
  const [row] = await db.select().from(modelConnections).where(eq(modelConnections.id, id));
  if (!row) throw new AppError('not_found', 'No such model connection');
  return row;
}

async function nameFree(db: Db, name: string, id?: string) {
  const [taken] = await db
    .select({ id: modelConnections.id })
    .from(modelConnections)
    .where(eq(modelConnections.name, name));
  if (taken && taken.id !== id) {
    throw new AppError('connection_exists', `A model connection named ${name} already exists`);
  }
}

/** Checks the key before keeping it: a connection that cannot list its models is no use. */
export async function createModelConnection(
  db: Db,
  secret: Buffer,
  userId: string,
  input: { name: string; kind: ModelConnectionKind; baseUrl?: string; key: string },
  fetchImpl?: FetchLike,
) {
  const baseUrl = input.baseUrl ?? DEFAULT_URL[input.kind];
  if (!baseUrl) throw new AppError('bad_request', "Give the gateway's address");
  await nameFree(db, input.name);
  const models = await readModels(input.kind, baseUrl, input.key, fetchImpl);
  const [row] = await db
    .insert(modelConnections)
    .values({
      name: input.name,
      kind: input.kind,
      baseUrl,
      keyCiphertext: encryptSecret(secret, input.key),
      models,
      checkedAt: new Date(),
      createdBy: userId,
    })
    .returning();
  if (!row) throw new AppError('internal', 'The connection was not saved');
  return viewOf(row);
}

/** A new address or key is checked as a new connection is; a new name alone is not. */
export async function updateModelConnection(
  db: Db,
  secret: Buffer,
  id: string,
  input: { name?: string; baseUrl?: string; key?: string },
  fetchImpl?: FetchLike,
) {
  const row = await rowFor(db, id);
  if (input.name) await nameFree(db, input.name, id);
  // The stored key goes only to the address it was entered for: a new address takes it anew.
  if (input.baseUrl !== undefined && input.baseUrl !== row.baseUrl && input.key === undefined) {
    throw new AppError(
      'validation_failed',
      'Enter the key again for the new address: a saved key goes only where it was entered for',
    );
  }
  const baseUrl = input.baseUrl ?? row.baseUrl;
  const key = input.key ?? decryptSecret(secret, row.keyCiphertext);
  const recheck = input.baseUrl !== undefined || input.key !== undefined;
  const models = recheck ? await readModels(row.kind, baseUrl, key, fetchImpl) : row.models;
  const [updated] = await db
    .update(modelConnections)
    .set({
      name: input.name ?? row.name,
      baseUrl,
      keyCiphertext: input.key ? encryptSecret(secret, input.key) : row.keyCiphertext,
      models,
      checkedAt: recheck ? new Date() : row.checkedAt,
    })
    .where(eq(modelConnections.id, id))
    .returning();
  if (!updated) throw new AppError('not_found', 'No such model connection');
  return viewOf(updated);
}

/** Reads the models again: what a gateway serves changes without Agentome knowing. */
export async function checkModelConnection(
  db: Db,
  secret: Buffer,
  id: string,
  fetchImpl?: FetchLike,
) {
  const row = await rowFor(db, id);
  const models = await readModels(
    row.kind,
    row.baseUrl,
    decryptSecret(secret, row.keyCiphertext),
    fetchImpl,
  );
  const [updated] = await db
    .update(modelConnections)
    .set({ models, checkedAt: new Date() })
    .where(eq(modelConnections.id, id))
    .returning();
  if (!updated) throw new AppError('not_found', 'No such model connection');
  return viewOf(updated);
}

export async function deleteModelConnection(db: Db, id: string) {
  const deleted = await db
    .delete(modelConnections)
    .where(eq(modelConnections.id, id))
    .returning({ id: modelConnections.id });
  if (deleted.length === 0) throw new AppError('not_found', 'No such model connection');
}
