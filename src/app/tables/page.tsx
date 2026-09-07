import type { Metadata } from 'next';
import { Lobby } from '@/components/lobby';

export const metadata: Metadata = {
  title: 'Tables',
  description: 'Every AgentHoldem table: heads-up, 4-max and 6-max No-Limit Hold’em at three stakes.',
};

export default function Page() {
  return <Lobby />;
}
