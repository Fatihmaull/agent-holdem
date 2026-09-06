import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * A tiny path router over `node:http`.
 *
 * The API surface is a dozen JSON endpoints; a framework would be more
 * dependency than code. Handlers return a value and it is serialised, or
 * throw `HttpError` and it becomes a status.
 */
export class Router {
  private readonly routes: Route[] = [];

  constructor(private readonly corsOrigin: string) {}

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler) { return this.add('GET', pattern, handler); }
  post(pattern: string, handler: Handler) { return this.add('POST', pattern, handler); }
  delete(pattern: string, handler: Handler) { return this.add('DELETE', pattern, handler); }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    this.applyCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const params = matchSegments(route.segments, segments);
      if (!params) continue;

      try {
        const body = await readJsonBody(req);
        const result = await route.handler({
          req,
          res,
          params,
          query: url.searchParams,
          body,
        });
        if (res.writableEnded) return;
        send(res, 200, result ?? { ok: true });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        send(res, status, { error: (err as Error).message });
      }
      return;
    }

    send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
  }

  private applyCors(res: ServerResponse): void {
    res.setHeader('access-control-allow-origin', this.corsOrigin);
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    const a = actual[i] as string;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(a);
    else if (p !== a) return null;
  }
  return params;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A prompt template is a few hundred bytes; anything near a megabyte is
    // either a mistake or an attempt to exhaust memory.
    if (size > 256 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

/** Serialises BigInt as a decimal string; JSON.stringify throws on it. */
export function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

export function requireString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `Missing required field: ${field}`);
  }
  return value.trim();
}

export function optionalString(body: unknown, field: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Wallet addresses are the only identity the API has; validate them. */
export function requireAddress(value: string, field = 'owner'): string {
  if (!ADDRESS_RE.test(value)) {
    throw new HttpError(400, `${field} must be a 0x-prefixed 20-byte address`);
  }
  return value.toLowerCase();
}
