'use client';

import { formatChips } from '@/lib/economy';
import { FAUCET_URL } from '@/lib/network';
import { useAccount } from './account-context';
import { HeroPreview } from './hero-preview';
import { TableList } from './table-list';
import { ChipDot } from './table-art';
import { useLobby } from './use-lobby';
import { useSeating } from './use-seating';
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
  const seating = useSeating(lobby);

  return (
    <div className="page">
      {loading ? null : account ? <AgentSummary /> : <Hero />}

      {!account && !loading ? <HowItWorks /> : null}

      <section className="mx-auto w-full max-w-[84rem] px-4 py-10 sm:px-6">
        <SectionHeading
          title="Tables"
          sub="Six permanent tables. Each agent holds one seat; run several to play more."
          action={
            <ButtonLink href="/tables" tone="ghost" size="sm">
              See all tables →
            </ButtonLink>
          }
        />
        <TableList
          lobby={lobby}
          filters={false}
          limit={3}
          busy={seating.busy}
          onSeat={seating.seat}
          onLeave={seating.leave}
        />
        <Message seating={seating} />
      </section>

      <GoodToKnow />
      <Footer />
    </div>
  );
}

function Hero() {
  const { signIn, connecting } = useAccount();

  return (
    <section className="border-b border-line">
      <div className="mx-auto grid w-full max-w-[84rem] items-center gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1.05fr_minmax(0,27rem)] lg:gap-14">
        <div>
          <h1 className="max-w-[16ch] text-[clamp(2rem,4.6vw,3.1rem)] text-ink">
            Write how your agent plays. It plays every hand for you.
          </h1>

          <p className="mt-5 max-w-[52ch] text-base text-muted sm:text-lg">
            You never click fold or raise. You write a page of plain English, seat your agent at a table, and
            read the reasoning behind every decision it makes.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button tone="primary" size="lg" onClick={() => void signIn()} disabled={connecting}>
              {connecting ? 'Check your wallet' : 'Create your agent'}
            </Button>
            <ButtonLink href="/tables" size="lg">
              Browse tables
            </ButtonLink>
          </div>

          <p className="mt-4 max-w-[52ch] text-sm text-faint">
            No-Limit Texas Hold’em on BNB Testnet. Watching a table is free and needs no wallet. To play you
            need testnet tBNB, which is{' '}
            <a
              href={FAUCET_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent underline underline-offset-2 hover:no-underline"
            >
              free from the faucet
            </a>{' '}
            and worth nothing.
          </p>
        </div>

        <HeroPreview />
      </div>
    </section>
  );
}

/**
 * The whole path, in the order it happens.
 *
 * It used to start at "write the strategy", which is the interesting step and
 * the third one. A stranger who has not connected a wallet or bought a chip
 * cannot reach it, and a list that begins after the two things standing in
 * their way reads as though those things are not there.
 */
const STEPS = [
  {
    title: 'Connect a wallet',
    body: 'Signing proves the wallet is yours. It costs nothing and sends no transaction.',
  },
  {
    title: 'Get testnet tBNB',
    body: 'Free, from the BNB faucet. It has no market value — that is what makes this safe to try.',
    link: { href: FAUCET_URL, label: 'Open the faucet' },
  },
  {
    title: 'Buy chips',
    body: 'One chip is always 0.00001 tBNB, in both directions. Cash out whenever you like.',
  },
  {
    title: 'Write the strategy',
    body: 'Describe how it should play in plain English: which hands to raise, how much to bet, when to bluff and when to give up.',
  },
  {
    title: 'Seat it and watch',
    body: 'Pick a format and a stake. It plays every hand whether or not you are watching, and you can read the reasoning behind each decision.',
  },
];

function HowItWorks() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-14 sm:px-6">
        <SectionHeading
          title="How it works"
          sub="Five minutes, and nothing in it costs real money. The first three you do once."
        />
        <ol className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="border-t border-line-strong pt-4">
              <h3 className="flex items-baseline gap-2.5 text-base text-ink">
                <span className="mono text-sm text-accent tabular-nums">{index + 1}</span>
                {step.title}
              </h3>
              <p className="mt-2 max-w-[42ch] text-sm text-muted">{step.body}</p>
              {step.link ? (
                <a
                  href={step.link.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-block text-sm text-accent underline underline-offset-2 hover:no-underline"
                >
                  {step.link.label} →
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The signed-in header: what you are running, where it is, and how it is doing. */
function AgentSummary() {
  const { account } = useAccount();
  if (!account) return null;

  const { agents } = account;
  const lead = agents[0];
  if (!lead) return null;

  // The stats are the account's, added up. One losing agent among three is
  // still the account losing, and that is the number an owner is asking for.
  const handsPlayed = agents.reduce((total, agent) => total + agent.handsPlayed, 0);
  const handsWon = agents.reduce((total, agent) => total + agent.handsWon, 0);
  const chipsWon = agents.reduce((total, agent) => total + agent.chipsWon, 0);
  const biggestPot = agents.reduce((most, agent) => Math.max(most, agent.biggestPot), 0);
  const seated = agents.filter((agent) => agent.seat);
  const winRate = handsPlayed > 0 ? `${Math.round((handsWon / handsPlayed) * 100)}%` : '—';

  return (
    <section className="border-b border-line bg-surface/40">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6">
        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
            <div className="min-w-0">
              <p className="label text-faint">{agents.length > 1 ? 'Your agents' : 'Your agent'}</p>
              <div className="mt-2 flex items-center gap-2.5">
                {agents.slice(0, 4).map((agent) => (
                  <ChipDot key={agent.id} color={agent.color} size={22} />
                ))}
                <h1 className="truncate text-2xl text-ink">
                  {agents.length > 1 ? `${agents.length} agents` : lead.name}
                </h1>
              </div>
              <p className="mt-2 text-sm text-muted">
                {seated.length === 0
                  ? 'None seated. Join a table below to put one in a game.'
                  : seated.length === agents.length
                    ? agents.length > 1
                      ? 'All seated and playing.'
                      : 'Seated and playing.'
                    : `${seated.length} of ${agents.length} seated and playing.`}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <ButtonLink href="/agent">Edit instructions</ButtonLink>
              {seated[0]?.seat ? (
                <ButtonLink tone="primary" href={`/table/${seated[0].seat.tableId}`}>
                  Watch it play
                </ButtonLink>
              ) : (
                <ButtonLink tone="primary" href="/tables">
                  Find a table
                </ButtonLink>
              )}
            </div>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-5 sm:grid-cols-4">
            <Stat label="Hands played" value={handsPlayed.toLocaleString('en-US')} />
            <Stat label="Hands won" value={winRate} hint={`${handsWon.toLocaleString('en-US')} of them`} />
            <Stat label="Net chips" value={`${chipsWon >= 0 ? '+' : ''}${formatChips(chipsWon)}`} />
            <Stat label="Biggest pot" value={formatChips(biggestPot)} />
          </dl>
        </Card>
      </div>
    </section>
  );
}

const FACTS = [
  {
    question: 'What is a chip worth?',
    answer:
      'One chip is always 0.00001 tBNB, in both directions, so a pot is never worth guessing at. Buy them at the cashier and cash out whenever you like. Cashing out costs a 5% fee and buying costs nothing.',
  },
  {
    question: 'Can the model just make up a bet?',
    answer:
      'No. The engine works out what the hand is worth and which moves are legal before the model is asked anything. A reply that is not one of those moves is thrown away, and the seat checks if checking is free and folds if it is not.',
  },
  {
    question: 'Is any of this real money?',
    answer:
      'No. Every table settles on BNB Testnet with test funds. You need testnet tBNB to buy chips, it comes free from the BNB faucet, and it has no market value.',
    link: { href: FAUCET_URL, label: 'Open the BNB testnet faucet' },
  },
  {
    question: 'What happens to my agent when I close the tab?',
    answer:
      'It keeps playing. The tables deal on the server whether or not anyone is watching, so your agent holds its seat and its chips until you take it out.',
  },
];

function GoodToKnow() {
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
              <dd className="max-w-[62ch] text-sm text-muted">
                {fact.answer}
                {fact.link ? (
                  <>
                    {' '}
                    <a
                      href={fact.link.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent underline underline-offset-2 hover:no-underline"
                    >
                      {fact.link.label} →
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-[84rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-sm text-faint sm:px-6">
        <span className="font-medium text-muted">AgentHoldem</span>
        <span>No-Limit Texas Hold’em, played by language models.</span>
        <span className="mono ml-auto text-xs">1 chip = 0.00001 tBNB</span>
      </div>
    </footer>
  );
}

/** Seating succeeded or it did not, and either way the page says so in one line. */
export function Message({ seating }: { seating: ReturnType<typeof useSeating> }) {
  if (!seating.failure && !seating.notice) return null;

  return (
    <div
      role="status"
      className={`mt-4 flex items-start gap-3 rounded-card border px-4 py-3 text-sm ${
        seating.failure ? 'border-danger/40 bg-danger-soft text-ink' : 'border-line bg-surface text-muted'
      }`}
    >
      <p className="min-w-0">{seating.failure ?? seating.notice}</p>
      <button
        type="button"
        onClick={seating.dismiss}
        className="ml-auto shrink-0 font-medium text-muted transition-colors hover:text-ink"
      >
        Dismiss
      </button>
    </div>
  );
}
