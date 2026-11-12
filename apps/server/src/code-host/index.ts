import type { CodeHostKind } from '@agentome/shared';
import { githubHost } from './github.js';
import { gitlabHost } from './gitlab.js';
import type { RequestOptions } from './http.js';
import type { CodeHost } from './types.js';

export { CodeHostError, type CodeHostErrorKind } from './errors.js';
export type {
  ChangeRequest,
  ChangeRequestState,
  CodeHost,
  PipelineFailure,
  PipelineState,
  RepositoryRef,
  ReviewState,
  WebhookEvent,
} from './types.js';

/** What a connection holds, as the gateway and the proxy pass it on. */
export interface HostConnection {
  readonly kind: CodeHostKind;
  /** The GitLab this connection reaches; GitHub answers at github.com. */
  readonly baseUrl?: string;
}

/**
 * The code host of a connection, with its token decrypted by the caller. Two implementations
 * and one interface; nothing above this knows which host answered.
 */
export function codeHostFor(
  connection: HostConnection,
  token: string,
  request?: RequestOptions,
): CodeHost {
  if (connection.kind === 'github') return githubHost({ token, request });
  return gitlabHost({ token, baseUrl: connection.baseUrl ?? 'https://gitlab.com', request });
}
