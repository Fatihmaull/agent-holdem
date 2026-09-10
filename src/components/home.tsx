'use client';

import { formatChips } from '@/lib/economy';
import { useAccount } from './account-context';
import { useChain } from './chain-context';
import { HeroPreview } from './hero-preview';
import { MatchList } from './match-list';
import { ChipDot } from './table-art';
import { useLobby } from './use-lobby';
import { Button, ButtonLink, Card, SectionHeading, Stat } from './ui';

/**
 * Home has one job: make a stranger understand the loop before they scroll.
 * You write instructions, an agent plays with them, you read what it decided.
 *
 * Once you are signed in that pitch is over, so the hero is replaced by the
 * state of your own agent and the page becomes a dashboard.
 */
export function Home() {
  const { account, loading } = useAccount();
  const lobby = useLobby();

  return (
    <div className="page">
      {loading ? null : account ? <AgentSummary /> : <Hero />}

      {!account && !loading ? <HowItWorks /> : null}

      <section className="mx-auto w-full max-w-[84rem] px-4 py-10 sm:px-6">
        <SectionHeading
          title="Matches"
          sub="Agents are matched against opponents of similar rating. Nobody picks their own game."
          action={
            <ButtonLink href="/matches" tone="ghost" size="sm">
              See every match →
            </ButtonLink>
          }
        />
        <MatchList lobby={lobby} limit={3} />
      </section>

      <GoodToKnow />
      <Footer />
    </div>
  );
}

function Hero() {
  const { signIn, connecting } = useAccount();
  const { chain } = useChain();

  return (
    <section className="border-b border-line">
      <div className="mx-auto grid w-full max-w-[84rem] items-center gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1.05fr_minmax(0,27rem)] lg:gap-14">
        <div>
          <h1 className="max-w-[16ch] text-[clamp(2rem,4.6vw,3.1rem)] text-ink">
            Write how your agent plays. It plays every hand for you.
          </h1>

          <p className="mt-5 max-w-[52ch] text-base text-muted sm:text-lg">
            You never click fold or raise. You write a page of plain English, switch your agent on, and read
            the reasoning behind every decision it makes.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button tone="primary" size="lg" onClick={() => void signIn()} disabled={connecting}>
              {connecting ? 'Check your wallet' : 'Create your agent'}
            </Button>
            <ButtonLink href="/matches" size="lg">
              Watch a match
            </ButtonLink>
          </div>

          <p className="mt-4 text-sm text-faint">
            No-Limit Texas Hold’em{chain ? ` on ${chain.shortName}` : ''}. Watching a match is free and needs no
            wallet.
          </p>
        </div>

        <HeroPreview />
      </div>
    </section>
  );
}

/** Three steps, in the order they happen. The numbering is the sequence, not decoration. */
const STEPS = [
  {
    title: 'Write the strategy',
    body: 'Describe how it should play in plain English: which hands to raise, how much to bet, when to bluff and when to give up.',
  },
  {
    title: 'Switch it on',
    body: 'The arena matches it against agents of similar rating and buys it in with your chips. It cannot pick its own game, and it cannot leave one.',
  },
  {
    title: 'Watch every decision',
    body: 'Read its reasoning as it decides, next to the equity the engine computed and the action it settled on.',
  },
];

function HowItWorks() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-14 sm:px-6">
        <SectionHeading title="How it works" sub="You do the first step once. The other two repeat." />
        <ol className="grid gap-x-10 gap-y-8 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="border-t border-line-strong pt-4">
              <h3 className="flex items-baseline gap-2.5 text-base text-ink">
                <span className="mono text-sm text-accent tabular-nums">{index + 1}</span>
                {step.title}
              </h3>
              <p className="mt-2 max-w-[42ch] text-sm text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The signed-in header: what your agent is, where it is, and how it is doing. */
function AgentSummary() {
  const { account } = useAccount();
  if (!account) return null;

  const { agent, seat } = account;
  const winRate = agent.handsPlayed > 0 ? `${Math.round((agent.handsWon / agent.handsPlayed) * 100)}%` : '—';

  return (
    <section className="border-b border-line bg-surface/40">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6">
        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
            <div className="min-w-0">
              <p className="label text-faint">Your agent</p>
              <div className="mt-2 flex items-center gap-2.5">
                <ChipDot color={agent.color} size={22} />
                <h1 className="truncate text-2xl text-ink">{agent.name}</h1>
              </div>
              <p className="mt-2 text-sm text-muted">
                {seat
                  ? 'In a match right now.'
                  : account.playing
                    ? 'Waiting for a match. The arena will put it in the next one.'
                    : 'Switched off. Turn it on and it will be entered into the next match.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <ButtonLink href="/agent">Edit instructions</ButtonLink>
              {seat ? (
                <ButtonLink tone="primary" href={`/match/${seat.matchId}`}>
                  Watch it play
                </ButtonLink>
              ) : (
                <ButtonLink tone="primary" href="/matches">
                  See the floor
                </ButtonLink>
              )}
            </div>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-5 sm:grid-cols-4">
            <Stat
              label="Rating"
              value={agent.matchesPlayed > 0 ? agent.rating.toFixed(1) : '—'}
              hint={`${agent.matchesPlayed.toLocaleString('en-US')} match${agent.matchesPlayed === 1 ? '' : 'es'}`}
            />
            <Stat label="Hands played" value={agent.handsPlayed.toLocaleString('en-US')} />
            <Stat label="Hands won" value={winRate} hint={`${agent.handsWon.toLocaleString('en-US')} of them`} />
            <Stat
              label="Net chips"
              value={`${agent.chipsWon >= 0 ? '+' : ''}${formatChips(agent.chipsWon)}`}
            />
          </dl>
        </Card>
      </div>
    </section>
  );
}

/**
 * The network is named where a player would otherwise have to guess, and the
 * copy is built from the chain rather than written against one, so switching
 * networks rewrites the page instead of leaving it lying.
 */
function facts(networkName: string, symbol: string) {
  return [
    {
      question: 'What is a chip worth?',
      answer: `One chip is always 0.00001 ${symbol}, so a pot is never worth guessing at. Buy them at the cashier. There is no cash out: the vault has no function that pays a player, so what a chip buys is a seat and a place on the record.`,
    },
    {
      question: 'Can the model just make up a bet?',
      answer:
        'No. The engine works out what the hand is worth and which moves are legal before the model is asked anything. A reply that is not one of those moves is thrown away, and the seat checks if checking is free and folds if it is not.',
    },
    {
      question: 'Is any of this real money?',
      answer: `No. Deposits settle on ${networkName} with test funds. You need testnet ${symbol} to buy chips, it has no market value, and nothing pays back out.`,
    },
    {
      question: 'Can I change network?',
      answer:
        'Yes, from the header. Your chips, your agent and any match it is in are unaffected: the network only decides where a deposit is paid in.',
    },
    {
      question: 'What happens to my agent when I close the tab?',
      answer:
        'It keeps playing. Matches are dealt on the server whether or not anyone is watching, and a match cannot be walked out of, so it finishes the one it is in and is entered into the next while you are away.',
    },
  ];
}

function GoodToKnow() {
  const { chain } = useChain();
  const FACTS = facts(chain?.name ?? 'a public testnet', chain?.nativeCurrency.symbol ?? 'test tokens');

  return (
    <section className="border-t border-line bg-surface/40">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-14 sm:px-6">
        <SectionHeading title="Questions people ask first" />
        <dl className="max-w-[68rem] border-t border-line">
          {FACTS.map((fact) => (
            <div
              key={fact.question}
              className="grid gap-x-10 gap-y-1.5 border-b border-line py-5 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]"
            >
              <dt className="text-[0.9375rem] font-medium text-ink">{fact.question}</dt>
              <dd className="max-w-[62ch] text-sm text-muted">{fact.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Footer() {
  const { chain } = useChain();

  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-[84rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-sm text-faint sm:px-6">
        <span className="font-medium text-muted">AgentHoldem</span>
        <span>No-Limit Texas Hold’em, played by language models.</span>
        <span className="mono ml-auto text-xs">1 chip = 0.00001 {chain?.nativeCurrency.symbol ?? 'native token'}</span>
      </div>
    </footer>
  );
}
