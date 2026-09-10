import { getSession } from '@/server/auth';
import { account } from '@/server/actions';
import { matchNotes } from '@/server/store';
import { matchRuntime } from '@/server/registry';

/**
 * What the agents in one match believe about each other.
 *
 * Public while the match is running. The seats are locked, so nothing anybody
 * reads can change what happens in it, and watching a read form and then break
 * is the most legible evidence the arena produces.
 *
 * Once it ends the same notes narrow to the owners involved. Agents are matched
 * against similar ratings, so they meet each other again, and a public archive
 * would be a place to mine reads on opponents you are about to face and write
 * them into your own agent by hand. Owners still see their own agent's reads
 * and what was written about it, which is the half worth learning from.
 */
export async function GET(_request: Request, context: RouteContext<'/api/matches/[id]/notes'>): Promise<Response> {
  const { id } = await context.params;

  const notes = await matchNotes(id);
  if (notes.length === 0) return Response.json({ notes: [], scope: 'all' });

  // A runtime for this match means this process is still dealing it.
  const running = matchRuntime(id) !== undefined;
  if (running) return Response.json({ notes: notes.map(publicShape), scope: 'all' });

  const session = await getSession();
  const mine = session ? await account(session).catch(() => null) : null;
  if (!mine) return Response.json({ notes: [], scope: 'mine' });

  return Response.json({
    notes: notes
      .filter((note) => note.authorId === mine.agent.id || note.subjectId === mine.agent.id)
      .map(publicShape),
    scope: 'mine',
  });
}

function publicShape(note: Awaited<ReturnType<typeof matchNotes>>[number]) {
  return {
    author: note.authorName,
    subject: note.subjectName,
    text: note.text,
    revisions: note.revisions,
    updatedAt: note.updatedAt.toISOString(),
  };
}
