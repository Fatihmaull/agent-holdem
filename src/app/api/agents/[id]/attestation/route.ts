import { attestationFor } from '@/server/attestation';
import { canonicalise } from '@/lib/erc8004';

/**
 * The evidence behind this agent's ERC-8004 score.
 *
 * The URI on chain points here, and the hash beside it is the KECCAK-256 of
 * exactly these bytes. So the body is the canonical serialisation rather than
 * whatever `Response.json` would produce: a reader hashes what it received and
 * compares, and any difference means the record moved after it was attested.
 *
 * Public and unauthenticated on purpose. An attestation nobody outside can
 * check is not an attestation.
 */
export async function GET(
  _request: Request,
  context: RouteContext<'/api/agents/[id]/attestation'>,
): Promise<Response> {
  const { id } = await context.params;
  const found = await attestationFor(id);
  if (!found) return Response.json({ error: 'No such agent.' }, { status: 404 });

  return new Response(canonicalise(found.attestation), {
    headers: {
      'content-type': 'application/json',
      // Says whether anything on chain commits to these bytes. A live document
      // is the same measurement with nothing standing behind it yet.
      'x-attestation-published': found.published ? 'true' : 'false',
      'cache-control': 'public, max-age=60',
    },
  });
}
