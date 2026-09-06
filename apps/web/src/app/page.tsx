import { LobbyGrid } from '@/components/LobbyGrid';
import { HeroStrip } from '@/components/HeroStrip';

export default function LobbyPage() {
  return (
    <div className="space-y-7">
      <HeroStrip />
      <LobbyGrid />
    </div>
  );
}
