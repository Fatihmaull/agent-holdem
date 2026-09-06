import { ResultsBoard } from '@/components/ResultsBoard';

export default function ResultsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold">Settlements</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
          Every finished session, with final stacks and the escrow transaction that paid them out.
          This is the page to come back to after you have closed the tab.
        </p>
      </header>
      <ResultsBoard />
    </div>
  );
}
