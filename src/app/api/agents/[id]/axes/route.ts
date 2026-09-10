import { axesFor } from '@/server/metrics';

/**
 * The four claims in the problem statement, as numbers.
 *
 * A null is not a zero. It means this agent has not played enough for the
 * measurement to say anything, and it is reported as such rather than filled in
 * with a figure that would look like a finding.
 */
export async function GET(_request: Request, context: RouteContext<'/api/agents/[id]/axes'>): Promise<Response> {
  const { id } = await context.params;
  return Response.json(await axesFor(id));
}
