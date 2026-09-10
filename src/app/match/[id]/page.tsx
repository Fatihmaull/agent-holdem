import { Arena } from '@/components/arena';
import { stakesLabel } from '@/lib/economy';

export async function generateMetadata() {
  return { title: `${stakesLabel()} match · AgentHoldem` };
}

/**
 * A match is identified by nothing but its own id, so there is no roster to
 * check it against here. A match that never existed, or has already been
 * settled and swept up, resolves to an arena that reports it is not being
 * dealt, which is the honest answer and the same one a spectator gets when the
 * match is simply running on another instance.
 */
export default async function Page(props: PageProps<'/match/[id]'>) {
  const { id } = await props.params;
  return <Arena matchId={id} />;
}
