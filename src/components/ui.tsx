'use client';

import Link from 'next/link';

/**
 * The shared control vocabulary. Every button, card, badge and tab in the
 * product comes from here, so a control that looks the same behaves the same
 * and nothing has to be restyled twice.
 */

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const TONES: Record<ButtonTone, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'border border-line-strong bg-surface-2 text-ink hover:bg-surface-3 hover:border-line-strong',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink',
  danger: 'border border-danger/40 bg-danger-soft text-danger hover:border-danger/70',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-[0.8125rem]',
  md: 'h-9 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-5 text-[0.9375rem]',
};

/*
  A control gives under a press. It is 3% and 120ms and nobody will ever name
  it, which is the point: a button that does not move under the pointer is the
  difference between a page that responds and a page that merely re-renders.
*/
const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center rounded-control font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100';

export function Button({
  tone = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; size?: ButtonSize }) {
  return <button type="button" className={`${BUTTON_BASE} ${TONES[tone]} ${SIZES[size]} ${className}`} {...rest} />;
}

export function ButtonLink({
  href,
  tone = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: React.ComponentProps<typeof Link> & { tone?: ButtonTone; size?: ButtonSize }) {
  return (
    <Link href={href} className={`${BUTTON_BASE} ${TONES[tone]} ${SIZES[size]} ${className}`} {...rest}>
      {children}
    </Link>
  );
}

export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <div className={`rounded-card border border-line bg-surface ${className}`}>{children}</div>;
}

type BadgeTone = 'neutral' | 'accent' | 'warning' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-line-strong bg-surface-2 text-muted',
  accent: 'border-accent/35 bg-accent-soft text-accent',
  warning: 'border-warning/35 bg-warning/10 text-warning',
  danger: 'border-danger/35 bg-danger-soft text-danger',
};

export function Badge({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A table that is dealing right now. The dot is the convention people know. */
export function LiveBadge({ label = 'Live' }: { label?: string }) {
  return (
    <Badge tone="accent">
      <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
      {label}
    </Badge>
  );
}

export function Stat({
  label,
  value,
  hint,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="label text-faint">{label}</dt>
      <dd className="mono mt-1 text-lg text-ink tabular-nums">{value}</dd>
      {hint ? <p className="mt-0.5 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

/**
 * A segmented control. Used for lobby filters and for the panel tabs on the
 * watch page, because both are "pick exactly one of a short list".
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className = '',
}: {
  options: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`scroll-x flex max-w-full items-center gap-0.5 rounded-control border border-line bg-surface p-0.5 ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[0.375rem] px-3 text-[0.8125rem] font-medium whitespace-nowrap transition-colors ${
              active ? 'bg-surface-3 text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className={`mono text-[0.6875rem] tabular-nums ${active ? 'text-muted' : 'text-faint'}`}>
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * An empty screen is an invitation to act, so it always carries the action that
 * fills it rather than only reporting that there is nothing here.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <h3 className="text-base text-ink">{title}</h3>
      <p className="max-w-[42ch] text-sm text-muted">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function SectionHeading({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div>
        <h2 className="text-xl text-ink">{title}</h2>
        {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}
