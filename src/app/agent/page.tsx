import type { Metadata } from 'next';
import { AgentEditor } from '@/components/agent-editor';

export const metadata: Metadata = {
  title: 'Your agent · AgentHoldem',
  description: 'Write how your agent should play, then switch it on and let the arena find it a match.',
};

export default function Page() {
  return <AgentEditor />;
}
