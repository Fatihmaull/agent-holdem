import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { agents } from '../db/schema';
import { assignColor } from '../agent/colors';

/**
 * How an agent proves who it is.
 *
 * An agent is a program somebody else runs, so it cannot hold a browser session
 * and there is nobody at a keyboard to sign a challenge for it. It gets a
 * bearer token instead, minted once when the agent is registered from an
 * owner's signed-in session.
 *
 * Only the hash is stored. A database that leaks should not hand out working
 * credentials, which also means nobody can ever look a lost token up: the
 * answer to losing one is to rotate it, and that is the honest answer rather
 * than an inconvenience worked around.
 */

/** Bytes of entropy in a token. 32 is well past anything worth guessing at. */
const TOKEN_BYTES = 32;

/** Prefix so a leaked string is recognisable in a log or a public repository. */
const TOKEN_PREFIX = 'ah_';

export const MAX_AGENT_NAME = 24;

/** How many agents one account may register. */
export const MAX_AGENTS_PER_ACCOUNT = 8;

function mint(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Looks an agent up by the token it presented.
 *
 * The lookup is by hash, so the comparison Postgres does is already on a fixed
 * width digest rather than on the secret. The extra constant-time check guards
 * the case where a future caller compares hashes in JavaScript instead.
 */
export async function agentByToken(token: string): Promise<{
  agentId: string;
  userId: string;
  name: string;
  color: string;
} | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  const digest = hashToken(token);
  const [row] = await db
    .select({
      agentId: agents.id,
      userId: agents.userId,
      name: agents.name,
      color: agents.color,
      tokenHash: agents.tokenHash,
    })
    .from(agents)
    .where(eq(agents.tokenHash, digest))
    .limit(1);

  if (!row) return null;

  const presented = Buffer.from(digest, 'hex');
  const stored = Buffer.from(row.tokenHash, 'hex');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

  return { agentId: row.agentId, userId: row.userId, name: row.name, color: row.color };
}

export class RegistrationError extends Error {}

/**
 * Creates an agent for an owner and hands back its token, once.
 *
 * The colour is picked against every colour in use rather than the owner's own,
 * because it identifies the agent at a table full of strangers and two seats
 * wearing one colour is a spectator's problem, not an owner's.
 */
export async function registerAgent(userId: string, name: string): Promise<{ agentId: string; token: string }> {
  const trimmed = name.trim().slice(0, MAX_AGENT_NAME);
  if (trimmed.length === 0) throw new RegistrationError('Give the agent a name.');

  const token = mint();

  return db.transaction(async (tx) => {
    const mine = await tx.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId));
    if (mine.length >= MAX_AGENTS_PER_ACCOUNT) {
      throw new RegistrationError(`One account can run ${MAX_AGENTS_PER_ACCOUNT} agents.`);
    }

    const taken = await tx.select({ color: agents.color }).from(agents);
    const [created] = await tx
      .insert(agents)
      .values({
        userId,
        name: trimmed,
        color: assignColor(taken.map((row) => row.color)).id,
        tokenHash: hashToken(token),
      })
      .returning({ id: agents.id });

    return { agentId: created.id, token };
  });
}

/**
 * Issues a new token and invalidates the old one.
 *
 * A token ends up in a config file and a config file ends up in a repository,
 * so this is a routine operation rather than an incident response. Any socket
 * still open on the old token keeps working until it drops, because cutting a
 * live agent off mid-hand would cost its owner a match to fix a leak that is
 * already fixed.
 */
export async function rotateToken(userId: string, agentId: string): Promise<string> {
  const token = mint();

  const rotated = await db
    .update(agents)
    .set({ tokenHash: hashToken(token) })
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .returning({ id: agents.id });

  if (rotated.length === 0) throw new RegistrationError('No such agent on this account.');
  return token;
}

export async function renameAgent(userId: string, agentId: string, name: string): Promise<void> {
  const trimmed = name.trim().slice(0, MAX_AGENT_NAME);
  if (trimmed.length === 0) throw new RegistrationError('Give the agent a name.');

  const renamed = await db
    .update(agents)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .returning({ id: agents.id });

  if (renamed.length === 0) throw new RegistrationError('No such agent on this account.');
}

/** Notes that a socket opened, so an owner can see the arena saw their agent. */
export async function markSeen(agentId: string): Promise<void> {
  await db.update(agents).set({ lastSeenAt: new Date(), lastCloseReason: null }).where(eq(agents.id, agentId));
}

/** Notes why a socket ended, in the words an owner will read on their console. */
export async function markClosed(agentId: string, reason: string): Promise<void> {
  await db.update(agents).set({ lastCloseReason: reason }).where(eq(agents.id, agentId));
}
