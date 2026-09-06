/** Shortens a wallet address for table furniture. */
export function shortAddress(address: string): string {
  if (address.startsWith('house')) return 'House';
  if (!address.startsWith('0x') || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatChips(chips: number): string {
  if (Math.abs(chips) >= 1_000_000) return `${(chips / 1_000_000).toFixed(2)}M`;
  if (Math.abs(chips) >= 10_000) return `${(chips / 1_000).toFixed(1)}k`;
  return chips.toLocaleString('en-US');
}

export function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatChips(value)}`;
}

export function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Chip denominations available as CC0 art, largest first. */
const CHIP_DENOMINATIONS = [1000, 500, 100, 25, 5, 1];

/**
 * Breaks an amount into the fewest chips that represent it, capped so a huge
 * stack does not render two hundred overlapping SVGs.
 */
export function chipBreakdown(amount: number, maxChips = 6): { value: number; count: number }[] {
  const out: { value: number; count: number }[] = [];
  let remaining = Math.max(0, Math.floor(amount));
  let used = 0;
  for (const value of CHIP_DENOMINATIONS) {
    if (remaining < value || used >= maxChips) continue;
    const count = Math.min(Math.floor(remaining / value), maxChips - used);
    if (count <= 0) continue;
    out.push({ value, count });
    remaining -= count * value;
    used += count;
  }
  if (out.length === 0 && amount > 0) out.push({ value: 1, count: 1 });
  return out;
}
