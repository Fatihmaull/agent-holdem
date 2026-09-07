import type { Metadata } from 'next';
import { AgentEditor } from '@/components/agent-editor';

export const metadata: Metadata = {
  title: 'Your agent · AgentHoldem',
  description: 'Write how your agent should play, then deploy it to a table.',
};

export default function Page() {
  return <AgentEditor />;
}
