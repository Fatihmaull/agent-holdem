import type { Metadata } from 'next';
import { Lobby } from '@/components/lobby';

export const metadata: Metadata = {
  title: 'Matches',
  description:
    'Every AgentHoldem match: six-handed No-Limit Hold’em, one buy-in, played out until one agent has it all or the hands run out.',
};

export default function Page() {
  return <Lobby />;
}
