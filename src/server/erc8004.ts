import { createWalletClient, decodeEventLog, http, keccak256, toHex, type Hash, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { agents, attestations } from '../db/schema';
import { envPrefix } from '../lib/chains';
import {
  buildAttestation,
  canonicalise,
  confidenceIn,
  REPUTATION_DECIMALS,
  REPUTATION_TAGS,
  VALIDATION_TAG,
  type Attestation,
} from '../lib/erc8004';
import { chainDefinition, publicClientFor } from './chain';
import type { DeployedChain } from './chains';
import { identityRegistryAbi, reputationRegistryAbi, validationRegistryAbi } from './erc8004-abi';
import { leaderboard } from './metrics';

/**
 * Publishing this arena's records to ERC-8004.
 *
 * Nothing here runs inside the web server. Attestations are posted by an
 * operator running `pnpm attest`, for the same reason the vault has no payout:
 * the process serving pages holds no key and signs nothing, so a bug in a route
 * cannot move anything on chain. It also matches what an attestation is. A win
 * rate is a claim about a body of play, not about the last hand, and republishing
 * it every hand would cost gas to say almost nothing new.
 *
 * The addresses are per-chain and come from the environment the same way vaults
 * do, named after the chain's own key: `MONAD_TESTNET_IDENTITY_REGISTRY` and
 * its reputation and validation siblings.
 */

export class NotConfigured extends Error {}

interface Registries {
  identity: `0x${string}`;
  reputation: `0x${string}`;
  validation: `0x${string}`;
}

const REGISTRY_VARS = {
  identity: 'IDENTITY_REGISTRY',
  reputation: 'REPUTATION_REGISTRY',
  validation: 'VALIDATION_REGISTRY',
} as const;

/** Where the three singletons live on this chain, or a refusal naming what is missing. */
function registriesFor(chain: DeployedChain): Registries {
  const prefix = envPrefix(chain.key);
  const found: Partial<Registries> = {};
  const missing: string[] = [];

  for (const [key, suffix] of Object.entries(REGISTRY_VARS) as Array<[keyof Registries, string]>) {
    const name = `${prefix}_${suffix}`;
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
      continue;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new NotConfigured(`${name} is not an address: ${value}`);
    found[key] = value as `0x${string}`;
  }

  if (missing.length > 0) {
    throw new NotConfigured(
      `${chain.name} has no ERC-8004 registries configured. Set ${missing.join(', ')} to the singletons deployed there.`,
    );
  }

  return found as Registries;
}

/**
 * The key that signs attestations.
 *
 * Separate from the treasury on purpose. This one only ever writes claims, so a
 * deployment can hand it out to whatever posts them without also handing over
 * the account that owns the vault.
 */
function attestor(chain: DeployedChain): WalletClient {
  const key = process.env.ATTESTOR_PRIVATE_KEY?.trim();
  if (!key) {
    throw new NotConfigured('ATTESTOR_PRIVATE_KEY is not set. Attestations are signed, so they need an account.');
  }

  return createWalletClient({
    account: privateKeyToAccount(key as `0x${string}`),
    chain: chainDefinition(chain),
    transport: http(chain.rpcUrl),
  });
}

/**
 * Mints an ERC-8004 identity for an agent that does not have one.
 *
 * The URI points back at this arena's own record for the agent, which is the
 * document every later attestation is measured against. Returns the existing id
 * unchanged if it already has one: a second identity for the same agent would
 * split its record in half, which is the shape a Sybil takes here.
 */
export async function registerIdentity(
  chain: DeployedChain,
  agentId: string,
  baseUrl: string,
): Promise<{ registryId: string; txHash: Hash | null }> {
  const [agent] = await db
    .select({ id: agents.id, registryId: agents.registryId, registryChainId: agents.registryChainId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) throw new NotConfigured(`no agent ${agentId}`);
  if (agent.registryId !== null && agent.registryChainId === chain.id) {
    return { registryId: agent.registryId, txHash: null };
  }

  const registries = registriesFor(chain);
  const wallet = attestor(chain);
  if (!wallet.account) throw new NotConfigured('the attestor wallet has no account');

  const txHash = await wallet.writeContract({
    address: registries.identity,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [`${baseUrl}/api/agents/${agentId}/attestation`],
    account: wallet.account,
    chain: chainDefinition(chain),
  });

  // The id comes from the receipt rather than the return value, because a
  // write does not hand one back: the mint is only real once it is mined.
  const receipt = await publicClientFor(chain).waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error(`identity registration reverted: ${txHash}`);

  // Decoded by name, not by position. Identity is an ERC-721, so minting also
  // emits a transfer, and that event's first indexed topic is the sender rather
  // than the token. Reading topics positionally would record every agent as
  // token zero and point every attestation ever posted at the same identity.
  let registryId: string | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registries.identity.toLowerCase()) continue;

    try {
      const decoded = decodeEventLog({ abi: identityRegistryAbi, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Registered') continue;
      registryId = (decoded.args as unknown as { agentId: bigint }).agentId.toString();
      break;
    } catch {
      // Some other event of the registry's, or one this build does not know.
      continue;
    }
  }

  if (registryId === null) throw new Error(`identity registration emitted no Registered event: ${txHash}`);
  await db.update(agents).set({ registryId, registryChainId: chain.id }).where(eq(agents.id, agentId));

  return { registryId, txHash };
}

export interface Published {
  agentId: string;
  name: string;
  registryId: string;
  attestation: Attestation;
  evidenceHash: `0x${string}`;
  reputationTx: Hash;
  validationTx: Hash;
}

/**
 * Publishes one agent's record: the win rate to Reputation, how much to believe
 * it to Validation.
 *
 * The order matters. The validation request goes up first and commits to the
 * evidence hash, so the score that follows is answering a question that was
 * already public rather than one written to fit the answer.
 */
export async function publishRecord(chain: DeployedChain, agentId: string, baseUrl: string): Promise<Published> {
  const [record] = await leaderboard({ agentId, limit: 1 });
  if (!record) throw new NotConfigured(`no record for agent ${agentId}`);

  const [agent] = await db
    .select({ registryId: agents.registryId, registryChainId: agents.registryChainId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent?.registryId || agent.registryChainId !== chain.id) {
    throw new NotConfigured(`agent ${agentId} has no ERC-8004 identity on ${chain.name}. Register it first.`);
  }

  const registries = registriesFor(chain);
  const wallet = attestor(chain);
  if (!wallet.account) throw new NotConfigured('the attestor wallet has no account');

  const rating = { mu: record.ratingMu, sigma: record.ratingSigma };
  const attestation = buildAttestation({
    agentId,
    name: record.name,
    rating,
    matches: record.matchesPlayed,
    wins: record.wins,
    hands: record.rate.hands,
    winRateBb100: record.rate.rate,
    earnings: record.earnings,
    measuredAt: new Date(),
  });

  const uri = `${baseUrl}/api/agents/${agentId}/attestation`;
  const evidenceHash = keccak256(toHex(canonicalise(attestation)));
  const registryId = BigInt(agent.registryId);
  const validator = wallet.account.address;

  const validationTx = await wallet.writeContract({
    address: registries.validation,
    abi: validationRegistryAbi,
    functionName: 'validationRequest',
    args: [validator, registryId, uri, evidenceHash],
    account: wallet.account,
    chain: chainDefinition(chain),
  });
  await publicClientFor(chain).waitForTransactionReceipt({ hash: validationTx, confirmations: 1 });

  // Awaited like the others. Each of these is signed by the same account, so a
  // write sent before the previous one is mined can be built on the same nonce
  // and quietly replace it. Waiting is the whole fix.
  const responseTx = await wallet.writeContract({
    address: registries.validation,
    abi: validationRegistryAbi,
    functionName: 'validationResponse',
    args: [evidenceHash, confidenceIn(rating), uri, evidenceHash, VALIDATION_TAG],
    account: wallet.account,
    chain: chainDefinition(chain),
  });
  await publicClientFor(chain).waitForTransactionReceipt({ hash: responseTx, confirmations: 1 });

  const reputationTx = await wallet.writeContract({
    address: registries.reputation,
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args: [
      registryId,
      BigInt(Math.round(attestation.rating * 10 ** REPUTATION_DECIMALS)),
      REPUTATION_DECIMALS,
      REPUTATION_TAGS.game,
      REPUTATION_TAGS.metric,
      uri,
      uri,
      evidenceHash,
    ],
    account: wallet.account,
    chain: chainDefinition(chain),
  });
  await publicClientFor(chain).waitForTransactionReceipt({ hash: reputationTx, confirmations: 1 });

  await db.insert(attestations).values({
    agentId,
    chainId: chain.id,
    registryId: agent.registryId,
    matches: attestation.matches,
    rating: Math.round(attestation.rating * 10 ** REPUTATION_DECIMALS),
    ratingMu: attestation.ratingMu,
    ratingSigma: attestation.ratingSigma,
    confidence: attestation.confidence,
    evidenceHash,
    evidence: attestation,
    reputationTx,
    validationTx,
  });

  return {
    agentId,
    name: record.name,
    registryId: agent.registryId,
    attestation,
    evidenceHash,
    reputationTx,
    validationTx,
  };
}
