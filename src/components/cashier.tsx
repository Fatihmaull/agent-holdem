'use client';
/* eslint-disable @next/next/no-img-element */ // Same fixed-size chip art as the felt.

import { useEffect, useRef, useState } from 'react';
import { CHIP_PACKAGES, chipsToWei, formatBnb, formatChips, formatUsd, quoteRedemption } from '@/lib/economy';
import { sendDeposit, shortAddress } from '@/lib/wallet';
import { useAccount } from './account-context';

type Stage = 'idle' | 'signing' | 'confirming' | 'done';

export function Cashier({ onClose }: { onClose: () => void }) {
  const { account, refresh } = useAccount();
  const [stage, setStage] = useState<Stage>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [redeemAmount, setRedeemAmount] = useState('');
  /** Chip count the player has been asked to confirm, once they have asked to redeem it. */
  const [confirming, setConfirming] = useState<number | null>(null);
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
        const body = (await response.json()) as { deposits?: Array<{ txHash: string }> };
        const waiting = body.deposits?.[0];
        if (!waiting || cancelled) return;

        setStage('confirming');
        setStatus('Finishing a deposit from earlier.');
        const credited = await pollConfirm(waiting.txHash, (message) => {
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
    if (!account) return;
    setFailure(null);
    setStage('signing');
    setStatus('Approve the transaction in your wallet.');

    try {
      const intentResponse = await fetch('/api/cashier/intent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageId }),
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

      const credited = await pollConfirm(txHash, (message) => setStatus(message));
      await refresh();
      setStage('done');
      setStatus(`${formatChips(credited)} chips added.`);
    } catch (error) {
      setStage('idle');
      setStatus(null);
      setFailure(describe(error));
    }
  }

  async function cashOut() {
    const chips = Number(redeemAmount);
    if (!Number.isInteger(chips) || chips <= 0) {
      setFailure('Enter a whole number of chips to redeem.');
      return;
    }

    // A payout leaves the building. Nothing here can call it back, so it is
    // asked for twice rather than fired on a single stray click.
    if (confirming !== chips) {
      setFailure(null);
      setConfirming(chips);
      return;
    }
    setConfirming(null);

    setFailure(null);
    setStage('confirming');
    setStatus('Sending your payout.');

    try {
      const response = await fetch('/api/cashier/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chips }),
      });
      const body = (await response.json()) as { netWei?: string; error?: string };
      if (!response.ok || !body.netWei) throw new Error(body.error ?? 'The payout failed.');

      await refresh();
      setRedeemAmount('');
      setStage('done');
      setStatus(`${formatBnb(BigInt(body.netWei))} tBNB sent to your wallet.`);
    } catch (error) {
      setStage('idle');
      setStatus(null);
      setFailure(describe(error));
    }
  }

  const busy = stage === 'signing' || stage === 'confirming';
  const redeemQuote = Number(redeemAmount) > 0 ? quoteRedemption(Math.floor(Number(redeemAmount))) : null;

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
          <p className="mono text-xs text-faint">1 chip = 0.00001 tBNB</p>
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
                  <div className="mono text-[0.8125rem] text-muted tabular-nums">{formatBnb(wei)} tBNB</div>
                  <div className="mono text-xs text-faint tabular-nums">
                    {formatUsd(wei)} at a fixed testnet rate
                  </div>
                </div>

                <button
                  type="button"
                  disabled={busy || !account}
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
          <h3 className="label mb-3 text-faint">Cash out</h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-faint">Chips to redeem</span>
              <input
                inputMode="numeric"
                value={redeemAmount}
                onChange={(event) => {
                  setRedeemAmount(event.target.value.replace(/[^\d]/g, ''));
                  setConfirming(null);
                }}
                placeholder={account ? String(account.chips) : '0'}
                className="mono h-10 w-44 rounded-control border border-line-input bg-surface-2 px-3 text-ink tabular-nums outline-none focus:border-accent"
              />
            </label>

            <button
              type="button"
              disabled={busy || !account}
              onClick={() => void cashOut()}
              className={`inline-flex h-10 items-center justify-center rounded-control px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                confirming !== null
                  ? 'bg-danger text-ink'
                  : 'border border-line-strong bg-surface-2 text-ink hover:bg-surface-3'
              }`}
            >
              {confirming !== null ? 'Confirm payout' : 'Redeem'}
            </button>

            <p className="max-w-[34ch] text-xs text-faint">
              {confirming !== null && redeemQuote
                ? `Sending ${formatBnb(redeemQuote.netWei)} tBNB to ${account ? shortAddress(account.address) : 'your wallet'}. This cannot be undone.`
                : redeemQuote
                  ? `You receive ${formatBnb(redeemQuote.netWei)} tBNB. Fee ${formatBnb(redeemQuote.feeWei)} tBNB, 5%.`
                  : 'A 5% fee is taken on redemption. Buying chips is free.'}
            </p>
          </div>
        </div>

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
async function pollConfirm(txHash: string, onStatus: (message: string) => void): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch('/api/cashier/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash }),
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
