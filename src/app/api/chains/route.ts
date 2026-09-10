import { UnknownChain, enabledChains, publicChain, selectChain, selectedChain } from '@/server/chains';

/**
 * The networks this deployment settles on, and which one the caller is on.
 *
 * The browser is told what a chain is called, what its token is and where its
 * explorer lives, so nothing in the interface has a network name compiled into
 * it. The server's own RPC endpoint is not among it: wallets use their own.
 */
export async function GET(): Promise<Response> {
  const active = await selectedChain();
  return Response.json({
    chains: enabledChains().map(publicChain),
    active: active.key,
  });
}

/** Switches the caller to another network. Nothing about the account changes. */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { chain?: string } | null;
  if (!body?.chain) return Response.json({ error: 'Name the network to switch to.' }, { status: 400 });

  try {
    const chain = await selectChain(body.chain);
    return Response.json({ active: chain.key });
  } catch (error) {
    if (error instanceof UnknownChain) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
