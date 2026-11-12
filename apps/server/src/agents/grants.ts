import { agentGrants, type SQL, sql } from '@agentome/db';

// On its own, with nothing of the server in it: the runs, the gateway and the notifications read
// grants too, and the agents' service reads them back.
/**
 * A grant counts inside its term only. An agent that is with someone until a day has two:
 * theirs, which ends then, and its owner's, which starts then. Whoever reads `agent_grants` for
 * who may act, or who is told, asks for this too.
 */
export const grantInForce: SQL = sql`(${agentGrants.validFrom} is null or ${agentGrants.validFrom} <= now()) and (${agentGrants.validUntil} is null or ${agentGrants.validUntil} > now())`;
