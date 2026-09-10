import type { ActFrame, DecisionFrame, ServerFrame } from '@agentholdem/protocol';

/**
 * Who is connected, and how the rest of the arena talks to them.
 *
 * Presence is deliberately not a column. A socket is a fact about this process,
 * and writing it down would leave a stale "connected" behind after every crash,
 * which is the worst kind of wrong because it looks authoritative. The database
 * knows what an agent is; this knows whether it is here.
 *
 * Everything above this file talks to an `AgentLink` rather than to a socket,
 * so nothing outside the socket layer imports a WebSocket library. That is what
 * lets the matchmaker, the dealer and the account page all ask about presence
 * without any of them knowing how the wire works.
 */

export interface AgentLink {
  readonly agentId: string;
  readonly ownerId: string;
  /** Whether it has asked to be queued. Connecting alone is not asking. */
  readonly ready: boolean;
  /** Fire and forget. A closed socket swallows it rather than throwing. */
  send(frame: ServerFrame): void;
  /**
   * Asks for a move and waits for one.
   *
   * Resolves null when nothing usable came back in time, which covers a
   * timeout, a reply carrying the wrong correlation id, a malformed frame and a
   * socket that vanished. The caller treats all four the same way, because from
   * the table's point of view they are the same thing: nobody acted.
   */
  ask(
    frame: ActFrame,
    onReasoning: (text: string) => void,
    signal: AbortSignal,
  ): Promise<DecisionFrame | null>;
  /** Ends the connection with a code and a sentence the owner will read. */
  close(code: number, reason: string): void;
}

const globalForPresence = globalThis as unknown as {
  __agentholdemPresence?: Map<string, AgentLink>;
};

function registry(): Map<string, AgentLink> {
  if (!globalForPresence.__agentholdemPresence) globalForPresence.__agentholdemPresence = new Map();
  return globalForPresence.__agentholdemPresence;
}

/**
 * Puts a connection on the floor, replacing any earlier one for the same agent.
 *
 * The newer connection wins because the older one is almost always a socket the
 * far end has already forgotten about, and an agent that genuinely opened two
 * would otherwise be unable to recover from the first without waiting for a
 * timeout it cannot see.
 */
export function attach(link: AgentLink): AgentLink | undefined {
  const existing = registry().get(link.agentId);
  registry().set(link.agentId, link);
  return existing;
}

/** Removes a connection, but only if it is still the current one. */
export function detach(link: AgentLink): void {
  if (registry().get(link.agentId) === link) registry().delete(link.agentId);
}

export function linkFor(agentId: string): AgentLink | undefined {
  return registry().get(agentId);
}

export function presenceOf(agentId: string): { connected: boolean; ready: boolean } {
  const link = registry().get(agentId);
  return { connected: link !== undefined, ready: link?.ready ?? false };
}

/** Every agent currently asking for a game. What the matchmaker draws from. */
export function readyAgentIds(): string[] {
  return [...registry().values()].filter((link) => link.ready).map((link) => link.agentId);
}

/** How many sockets one account is holding. Used to cap them at the handshake. */
export function connectionsFor(ownerId: string): number {
  let count = 0;
  for (const link of registry().values()) if (link.ownerId === ownerId) count += 1;
  return count;
}

/** Hangs up on everyone, so a restart tells agents to come back rather than stalling them. */
export function closeAll(code: number, reason: string): void {
  for (const link of [...registry().values()]) link.close(code, reason);
  registry().clear();
}
