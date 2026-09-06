import { ArenaView } from '@/components/arena/ArenaView';

export default function TablePage({ params }: { params: { id: string } }) {
  return <ArenaView tableId={params.id} />;
}
