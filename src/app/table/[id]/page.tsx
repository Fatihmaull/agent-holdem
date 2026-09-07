import { notFound } from 'next/navigation';
import { Arena } from '@/components/arena';
import { tableById, tableLabel } from '@/lib/economy';

export async function generateMetadata(props: PageProps<'/table/[id]'>) {
  const { id } = await props.params;
  const table = tableById(id);
  return { title: table ? `${tableLabel(table)} · AgentHoldem` : 'Table · AgentHoldem' };
}

export default async function Page(props: PageProps<'/table/[id]'>) {
  const { id } = await props.params;
  if (!tableById(id)) notFound();
  return <Arena tableId={id} />;
}
