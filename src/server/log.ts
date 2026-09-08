/**
 * Structured logging.
 *
 * Three `console.log` calls scattered through a server is not observability: as
 * soon as something goes wrong at three in the morning, the only question worth
 * answering is "which hand, which account, which deposit", and a prose line
 * cannot be filtered by any of them. Every line here carries an event name and
 * a flat bag of fields, so a log platform can index it and a person can grep it.
 *
 * Deliberately dependency-free. A logging library is a runtime dependency in
 * the path of every hand, and the shape below is what a hosted collector wants
 * anyway: one JSON object per line on stdout.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): number {
  const name = (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug')) as LogLevel;
  return LEVELS[name] ?? LEVELS.info;
}

/**
 * Human-readable lines in development, one JSON object per line otherwise.
 *
 * Reading a wall of JSON while working on a hand is miserable, and a collector
 * cannot do anything useful with prose. Neither format is the right default for
 * both, so the environment picks.
 */
function pretty(): boolean {
  if (process.env.LOG_FORMAT === 'json') return false;
  if (process.env.LOG_FORMAT === 'pretty') return true;
  return process.env.NODE_ENV !== 'production';
}

/**
 * Where an error goes so that a person sees it.
 *
 * Set `ERROR_WEBHOOK_URL` to a Slack-style incoming webhook, or to anything
 * that accepts a JSON post. Unset, errors still reach stdout; this is the
 * difference between a log nobody tails and a message someone gets.
 */
const errorWebhook = process.env.ERROR_WEBHOOK_URL;

/** Fields that must never be written to a log, whatever a caller passes. */
const REDACT = /^(.*(key|secret|token|password|authorization|cookie).*)$/i;

function scrub(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [name, value] of Object.entries(fields)) {
    if (REDACT.test(name)) {
      safe[name] = '[redacted]';
      continue;
    }
    safe[name] = value instanceof Error ? value.message : value;
  }
  return safe;
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  if (LEVELS[level] < configuredLevel()) return;

  const safe = scrub(fields);
  if (pretty()) {
    const rest = Object.entries(safe)
      .map(([name, value]) => `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    console[level === 'debug' ? 'log' : level](`${level.toUpperCase().padEnd(5)} ${event}${rest ? ` ${rest}` : ''}`);
  } else {
    console[level === 'debug' ? 'log' : level](
      JSON.stringify({ level, event, at: new Date().toISOString(), ...safe }),
    );
  }

  if (level === 'error') void notify(event, safe);
}

let notifyFailed = false;

async function notify(event: string, fields: LogFields): Promise<void> {
  if (!errorWebhook || notifyFailed) return;
  try {
    await fetch(errorWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `AgentHoldem: ${event}\n${JSON.stringify(fields, null, 2)}` }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // A broken alerting endpoint must never take the server down with it, and
    // must not log an error either — that would call straight back into here.
    // Once is enough to know it is not working.
    notifyFailed = true;
  }
}

export const logger = {
  debug: (event: string, fields: LogFields = {}) => emit('debug', event, fields),
  info: (event: string, fields: LogFields = {}) => emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}) => emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}) => emit('error', event, fields),

  /**
   * A logger that stamps every line with the same fields.
   *
   * A table binds one of these to its own id so that a hand can be followed
   * through a log without the caller remembering to pass the id every time.
   */
  child(base: LogFields) {
    return {
      debug: (event: string, fields: LogFields = {}) => emit('debug', event, { ...base, ...fields }),
      info: (event: string, fields: LogFields = {}) => emit('info', event, { ...base, ...fields }),
      warn: (event: string, fields: LogFields = {}) => emit('warn', event, { ...base, ...fields }),
      error: (event: string, fields: LogFields = {}) => emit('error', event, { ...base, ...fields }),
    };
  },
};

export type Logger = typeof logger;
