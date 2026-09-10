import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { SiweMessage } from 'siwe';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { agents, ledgerEntries, users } from '../db/schema';
import { assignColor } from '../agent/colors';
import { STARTING_GRANT } from '../lib/economy';
import { enabledChains } from './chains';

const SESSION_COOKIE = 'ah_session';
const NONCE_COOKIE = 'ah_nonce';
const SESSION_TTL = '7d';
const NONCE_TTL = '10m';

export interface Session {
  userId: string;
  address: string;
}

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error('SESSION_SECRET is not set. Generate one with: openssl rand -base64 32');
  return new TextEncoder().encode(value);
}

async function sign(payload: Record<string, unknown>, ttl: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret());
}

async function read<T>(token: string | undefined): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as T;
  } catch {
    return null;
  }
}

/**
 * The host a sign-in message must be bound to.
 *
 * Reading this from the request would make the check circular: an attacker who
 * collected a signature for their own domain need only send that domain in the
 * `Host` header for it to verify here. In production the value is pinned by
 * configuration and the header is ignored. In development it falls back to the
 * request so that localhost, a LAN address and a tunnel all work unconfigured.
 */
export function expectedHost(requestHost: string): string {
  const configured = process.env.APP_ORIGIN;
  if (configured) {
    try {
      return new URL(configured).host;
    } catch {
      throw new Error(`APP_ORIGIN is not a URL: ${configured}`);
    }
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_ORIGIN is not set. Sign-in cannot be bound to a domain without it.');
  }

  return requestHost;
}

/** The origin sign-in messages point at, matching `expectedHost`. */
export function expectedOrigin(requestHost: string, requestProto: string): string {
  const configured = process.env.APP_ORIGIN;
  if (configured) return new URL(configured).origin;
  return `${requestProto}://${requestHost}`;
}

/** Issues a single-use nonce, held in a short-lived signed cookie. */
export async function issueNonce(): Promise<string> {
  const nonce = randomBytes(16).toString('hex');
  const jar = await cookies();
  jar.set(NONCE_COOKIE, await sign({ nonce }, NONCE_TTL), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  });
  return nonce;
}

export interface SignInResult {
  ok: boolean;
  error?: string;
  session?: Session;
}

/**
 * Verifies a Sign-In With Ethereum message and opens a session.
 *
 * The nonce is read from the cookie this server issued and cleared immediately,
 * so a captured message cannot be replayed. The domain is checked against this
 * deployment's configured host rather than against the request's own, which is
 * what stops a signature collected on another site from working here.
 */
export async function signIn(message: string, signature: string, requestHost: string): Promise<SignInResult> {
  let host: string;
  try {
    host = expectedHost(requestHost);
  } catch (error) {
    console.error('sign-in is misconfigured', error);
    return { ok: false, error: 'Sign-in is unavailable on this deployment.' };
  }

  const jar = await cookies();
  const issued = await read<{ nonce: string }>(jar.get(NONCE_COOKIE)?.value);
  jar.delete(NONCE_COOKIE);

  if (!issued) return { ok: false, error: 'Your sign-in request expired. Try again.' };

  let parsed: SiweMessage;
  try {
    parsed = new SiweMessage(message);
  } catch {
    return { ok: false, error: 'That sign-in message could not be read.' };
  }

  // Any chain this deployment settles on is an acceptable place to have signed.
  // The chain a signature names is not what makes it safe here: the nonce and
  // the domain are. Pinning one network instead would only break the player who
  // switched chains between fetching the message and signing it.
  const chains = enabledChains();
  if (!chains.some((chain) => chain.id === parsed.chainId)) {
    const names = chains.map((chain) => chain.shortName).join(' or ');
    return { ok: false, error: `Switch your wallet to ${names} and sign again.` };
  }

  const result = await parsed.verify({ signature, nonce: issued.nonce, domain: host }, { suppressExceptions: true });
  if (!result.success) return { ok: false, error: 'That signature did not match the message.' };

  const address = parsed.address.toLowerCase();
  const session = await openSession(address);
  return { ok: true, session };
}

async function openSession(address: string): Promise<Session> {
  const userId = await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.address, address)).limit(1);
    if (existing) return existing.id;

    const [created] = await tx
      .insert(users)
      .values({ address, chips: STARTING_GRANT })
      .returning({ id: users.id });

    // Written to the ledger like any other movement. The chips column is a
    // cache of these rows, so a balance that appeared without one would be the
    // only chips in the system nothing accounts for.
    await tx.insert(ledgerEntries).values({
      userId: created.id,
      delta: STARTING_GRANT,
      balanceAfter: STARTING_GRANT,
      reason: 'grant',
      reference: 'new-account',
    });

    // Every account gets one agent. It starts unnamed only in the sense that
    // the owner has not renamed it yet, never without an identity.
    const taken = await tx.select({ color: agents.color }).from(agents);
    await tx.insert(agents).values({
      userId: created.id,
      name: defaultAgentName(address),
      color: assignColor(taken.map((row) => row.color)).id,
      instructions: '',
      // Half the field plays without notes. Which half is a function of the
      // account itself rather than of how many accounts existed a moment ago:
      // two sign-ups landing together would read the same count and be put in
      // the same arm, and the split is the only thing making the comparison a
      // controlled one. Without a blind arm, any difference the notes appear to
      // make is a claim with no control behind it.
      notesEnabled: blindArm(created.id),
    });

    return created.id;
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, await sign({ userId, address }, SESSION_TTL), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });

  return { userId, address };
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const payload = await read<Session>(jar.get(SESSION_COOKIE)?.value);
  if (!payload?.userId || !payload.address) return null;
  return { userId: payload.userId, address: payload.address };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/**
 * Which side of the notes experiment an account lands on.
 *
 * Decided from its own identifier, so it is stable, needs no coordination, and
 * lands close to even across any number of accounts without anybody counting.
 */
function blindArm(userId: string): boolean {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash & 1) === 0;
}

/** Short, stable, and never the raw address. */
function defaultAgentName(address: string): string {
  return `Agent ${address.slice(2, 6).toUpperCase()}`;
}
