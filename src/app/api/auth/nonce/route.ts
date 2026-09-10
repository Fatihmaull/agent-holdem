import { headers } from 'next/headers';
import { SiweMessage } from 'siwe';
import { getAddress, isAddress } from 'viem';
import { expectedHost, expectedOrigin, issueNonce } from '@/server/auth';
import { selectedChain } from '@/server/chains';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * Issues the nonce and the exact message to sign.
 *
 * The message is built here, not in the browser, so the domain, chain and nonce
 * it binds to are the ones this server will check. The client signs the string
 * verbatim rather than editing it, which leaves nothing to get wrong. The chain
 * named is whichever one the player is currently on.
 */
export async function GET(request: Request): Promise<Response> {
  const allowed = take('sign-in', callerOf(request, null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const address = new URL(request.url).searchParams.get('address');
  if (!address || !isAddress(address)) {
    return Response.json({ error: 'Send the wallet address to sign with.' }, { status: 400 });
  }

  const headerList = await headers();
  const requestHost = headerList.get('host') ?? 'localhost:3000';
  const requestProto = headerList.get('x-forwarded-proto') ?? 'http';

  // Pinned by configuration in production. Signing a message for a domain this
  // server will not accept is worse than refusing to issue one.
  let host: string;
  let uri: string;
  try {
    host = expectedHost(requestHost);
    uri = expectedOrigin(requestHost, requestProto);
  } catch (error) {
    console.error('sign-in is misconfigured', error);
    return Response.json({ error: 'Sign-in is unavailable on this deployment.' }, { status: 500 });
  }

  const nonce = await issueNonce();

  const message = new SiweMessage({
    domain: host,
    address: getAddress(address),
    statement: 'Sign in to AgentHoldem. This proves the wallet is yours. It costs nothing and sends no transaction.',
    uri,
    version: '1',
    chainId: (await selectedChain()).id,
    nonce,
  });

  return Response.json({ message: message.prepareMessage() });
}
