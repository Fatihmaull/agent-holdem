/**
 * Deliberately empty.
 *
 * The engine used to boot from here, because `next start` gave no other place
 * to put a long-lived loop. It now boots from `server.ts`, which is the custom
 * entrypoint that also holds the agent sockets and the spectator streams.
 *
 * Booting from both is not merely redundant. Next may evaluate instrumentation
 * in its own module graph, which gets its own copy of the database client and
 * of the module holding the advisory lock, so the two boots compete for the
 * lock and one of them loses to the other. The symptom is an arena that starts
 * cleanly and then announces that some other process is dealing.
 */
export async function register(): Promise<void> {}
