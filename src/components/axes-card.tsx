'use client';

import { useEffect, useState } from 'react';
import { Card } from './ui';

interface Axes {
  reading: number | null;
  deception: number | null;
  adaptation: number | null;
  exploitation: number | null;
}

/**
 * The four claims, as numbers.
 *
 * A chip count says whether an agent made money. These say whether it read the
 * table, got believed, learned anything, and punished the weakest opponents
 * harder than everyone else does. Published work on poker-playing models found those orderings
 * routinely disagree, which is the whole reason to show both.
 */
const AXES: Array<{ key: keyof Axes; label: string; asks: string; format: (value: number) => string }> = [
  {
    key: 'reading',
    label: 'Reading',
    asks: 'Does it play differently against loose opponents than tight ones?',
    format: (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(0)} pts`,
  },
  {
    key: 'deception',
    label: 'Deception',
    asks: 'How often does a bet made with a weak hand take the pot down?',
    format: (value) => `${(value * 100).toFixed(0)}%`,
  },
  {
    key: 'adaptation',
    label: 'Adaptation',
    asks: 'Does it do better later in a stint than it did at the start of one?',
    format: (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} bb/100`,
  },
  {
    key: 'exploitation',
    label: 'Exploitation',
    asks: 'Does it beat the weakest opponents harder than everyone else does?',
    format: (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} bb/100`,
  },
];

export function AxesCard({ agentId, name }: { agentId: string; name?: string }) {
  const [axes, setAxes] = useState<Axes | null>(null);

  useEffect(() => {
    let live = true;

    fetch(`/api/agents/${agentId}/axes`, { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<Axes>) : null))
      .then((body) => {
        if (live && body) setAxes(body);
      })
      .catch(() => {
        // Leaving the card empty is honest. These are measurements, and a
        // failed request has not measured anything.
      });

    return () => {
      live = false;
    };
  }, [agentId]);

  return (
    <Card className="p-5">
      <h2 className="truncate text-base text-ink">{name ? `${name} profile` : 'Profile'}</h2>
      <p className="mt-1 text-xs text-faint">
        What the record says beyond the money, measured from hands against other agents. Exploitation is compared
        with how the whole field does against the weakest half of it.
      </p>

      <dl className="mt-4 space-y-4">
        {AXES.map((axis) => {
          const value = axes?.[axis.key] ?? null;
          return (
            <div key={axis.key}>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[0.8125rem] font-medium text-ink">{axis.label}</dt>
                {/* Null is not zero. It means this agent has not played enough
                    for the measurement to say anything, and saying so beats
                    printing a figure that would read as a finding. */}
                <dd className={`mono text-sm tabular-nums ${value === null ? 'text-faint' : 'text-ink'}`}>
                  {value === null ? 'not enough hands' : axis.format(value)}
                </dd>
              </div>
              <p className="mt-0.5 text-xs text-faint">{axis.asks}</p>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}
