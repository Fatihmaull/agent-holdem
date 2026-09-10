'use client';
/* eslint-disable @next/next/no-img-element */ // Same fixed-size chip art as the felt.

import { useEffect, useRef, useState } from 'react';
import { chainByKey } from '@/lib/chains';
import { CHIP_PACKAGES, chipsToWei, formatChips, formatNative, formatUsd } from '@/lib/economy';
import { sendDeposit } from '@/lib/wallet';
import { useAccount } from './account-context';
import { useChain } from './chain-context';

type Stage = 'idle' | 'signing' | 'confirming' | 'done';

export function Cashier({ onClose }: { onClose: () => void }) {
  const { account, refresh } = useAccount();
  const { chain } = useChain();
  const [stage, setStage] = useState<Stage>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  // Escape closes, and Tab stays inside. A modal the keyboard can walk out of
  // while the page behind it is still there is a modal in appearance only.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = dialog.current;
      if (!panel) return;

      const focusable = [
        ...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'),
      ].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A deposit paid for in an earlier visit and never credited is picked up
  // here, so closing the tab while it confirmed does not cost the player money.
  useEffect(() => {
    let cancelled = false;
    if (!account) return;

    void (async () => {
      try {
        const response = await fetch('/api/cashier/pending', { cache: 'no-store' });
        const body = (await response.json()) as { deposits?: Array<{ txHash: string; chainKey: string }> };
        const waiting = body.deposits?.[0];
        if (!waiting || cancelled) return;

        // Finished on the network it was paid on, whatever the player is
        // looking at now. A deposit does not follow them between chains.
        const paidOn = chainByKey(waiting.chainKey);
        setStage('confirming');
        setStatus(`Finishing a deposit from earlier${paidOn ? ` on ${paidOn.shortName}` : ''}.`);
        const credited = await pollConfirm(waiting.txHash, waiting.chainKey, (message) => {
          if (!cancelled) setStatus(message);
        });
        if (cancelled) return;
        await refresh();
        setStage('done');
        setStatus(`${formatChips(credited)} chips added.`);
      } catch (error) {
        if (!cancelled) {
          setStage('idle');
          setStatus(null);
          setFailure(describe(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account, refresh]);

  async function buy(packageId: string) {
    if (!account || !chain) return;
    setFailure(null);
    setStage('signing');
    setStatus('Approve the transaction in your wallet.');

    try {
      const intentResponse = await fetch('/api/cashier/intent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageId, chain: chain.key }),
      });
      const intent = (await intentResponse.json()) as {
        intentId?: string;
        bytes32?: `0x${string}`;
        vault?: `0x${string}`;
        valueWei?: string;
        error?: string;
      };
      if (!intentResponse.ok || !intent.bytes32) throw new Error(intent.error ?? 'Could not start the purchase.');

      const txHash = await sendDeposit({
        from: account.address,
        chain,
        vault: intent.vault!,
        intentId: intent.bytes32,
        valueWei: intent.valueWei!,
      });

      // Written down before anything else can fail. A deposit whose hash is on
      // record can be finished later; one whose hash was only ever in this tab
      // cannot.
      await fetch('/api/cashier/pending', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intentId: intent.intentId, txHash }),
      }).catch(() => {});

      setStage('confirming');
      setStatus('Waiting for the network to confirm. This takes a few blocks.');

      const credited = await pollConfirm(txHash, chain.key, (message) => setStatus(message));
      await refresh();
      setStage('done');
      setStatus(`${formatChips(credited)} chips added.`);
    } catch (error) {
      setStage('idle');
      setStatus(null);
      setFailure(describe(error));
    }
  }

  const busy = stage === 'signing' || stage === 'confirming';
  const symbol = chain?.nativeCurrency.symbol ?? '';
  // A chain can be switched on before its vault exists. Watching still works;
  // buying does not, and the dialog says so rather than failing at the wallet.
  const settles = Boolean(chain?.vault);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Cashier"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        // The shell does not scroll, so the dialog carries its own scrollbar rather
        // than relying on the page to make room for it.
        className="scroll-y max-h-full w-full max-w-3xl rounded-card border border-line bg-surface shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] outline-none"
      >
        <div className="flex items-baseline gap-4 border-b border-line px-6 py-5">
          <h2 className="text-2xl text-ink">Cashier</h2>
          <p className="mono text-xs text-faint">1 chip = 0.00001 {symbol || 'native token'}</p>
          {chain ? <p className="text-xs text-faint">on {chain.name}</p> : null}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-sm font-medium text-faint transition-colors hover:text-ink"
          >
            Close
          </button>
        </div>

        <div className="grid gap-px bg-line sm:grid-cols-3">
          {CHIP_PACKAGES.map((entry) => {
            const wei = chipsToWei(entry.chips);
            const usd = formatUsd(wei, chain?.notionalUsd);
            return (
              <div key={entry.id} className="flex flex-col gap-4 bg-surface p-6">
                <div className="flex items-baseline justify-between">
                  <span className="label text-faint">{entry.name}</span>
                  {entry.popular ? (
                    <span className="rounded-full bg-accent px-2 py-0.5 text-[0.6875rem] font-semibold text-accent-ink">
                      Most bought
                    </span>
                  ) : null}
                </div>

                <ChipTower chips={entry.chips} />

                <div>
                  <div className="mono text-2xl text-ink tabular-nums">{formatChips(entry.chips)}</div>
                  <div className="mono text-[0.8125rem] text-muted tabular-nums">
                    {formatNative(wei)} {symbol}
                  </div>
                  {usd ? (
                    <div className="mono text-xs text-faint tabular-nums">{usd} at a fixed testnet rate</div>
                  ) : null}
                </div>

                <button
                  type="button"
                  disabled={busy || !account || !settles}
                  onClick={() => void buy(entry.id)}
                  className="mt-auto inline-flex h-10 items-center justify-center rounded-control bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Buy {formatChips(entry.chips)} chips
                </button>
              </div>
            );
          })}
        </div>

        <div className="border-t border-line bg-surface-2 px-6 py-5">
          <h3 className="label mb-2 text-faint">There is no cash out</h3>
          <p className="max-w-[68ch] text-sm text-muted">
            Chips go in and do not come back out. The vault has no function that pays a player, so this is a property
            of the contract rather than a rule we keep. What a chip buys is table time and a place on the record.
          </p>
        </div>

        {chain && !settles ? (
          <div className="border-t border-line px-6 py-4">
            <p className="text-sm text-muted">
              No vault has been deployed on {chain.name} yet, so chips cannot be bought here. Switch networks in the
              header to use the cashier.
            </p>
          </div>
        ) : null}

        {status || failure ? (
          <div className="border-t border-line px-6 py-4">
            {failure ? (
              <p className="text-sm text-danger">{failure}</p>
            ) : (
              <p className="text-sm text-muted">{status}</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The package size drawn as height. A bigger package is a physically taller stack. */
function ChipTower({ chips }: { chips: number }) {
  const count = Math.max(3, Math.min(14, Math.round(Math.log10(chips) * 5)));
  return (
    <div className="relative h-24" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <img
          key={i}
          src="/chips/white-edge.png"
          alt=""
          width={52}
          height={24}
          className="absolute left-0"
          style={{ bottom: i * 7 }}
          draggable={false}
        />
      ))}
    </div>
  );
}

/**
 * A deposit is credited only once the chain has confirmed it, so the cashier
 * keeps asking rather than pretending the chips have arrived.
 */
async function pollConfirm(txHash: string, chainKey: string, onStatus: (message: string) => void): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch('/api/cashier/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, chain: chainKey }),
    });
    const body = (await response.json()) as { chips?: number; error?: string };

    if (response.ok && typeof body.chips === 'number') return body.chips;
    if (body.error && !/confirmation/i.test(body.error)) throw new Error(body.error);

    onStatus(body.error ?? 'Waiting for the network to confirm.');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(
    'That deposit has not confirmed yet. It is on record, so reopen the cashier later and it will be finished then.',
  );
}

function describe(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 4001) return 'Transaction rejected in your wallet.';
  if (error instanceof Error) return error.message;
  return 'The cashier could not complete that.';
}
