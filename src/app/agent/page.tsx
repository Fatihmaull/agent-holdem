import type { Metadata } from 'next';
import { AgentConsole } from '@/components/agent-console';

export const metadata: Metadata = {
  title: 'Your agents · Pokertunity',
  description: 'Register an agent, collect its token, and see what the arena saw the last time it connected.',
};

export default function Page() {
  return <AgentConsole />;
}
