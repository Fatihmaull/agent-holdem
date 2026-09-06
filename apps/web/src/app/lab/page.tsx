import { StrategyLab } from '@/components/StrategyLab';

export default function LabPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold">Prompt Strategy Lab</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
          Your brief is layer two of the prompt. Layer one — hole cards, board, pot, position,
          action history and the legal moves — is assembled by the engine every turn, so you never
          have to spend words describing the game. Spend them on the player.
        </p>
      </header>
      <StrategyLab />
    </div>
  );
}
