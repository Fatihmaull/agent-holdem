/**
 * Deposit intents are uuids in the database and bytes32 in the contract.
 * A uuid is sixteen bytes, so it is padded rather than hashed, which keeps the
 * mapping reversible and lets an on-chain event point straight back at a row.
 */

export function intentToBytes32(uuid: string): `0x${string}` {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return `0x${hex}${'0'.repeat(32)}`;
}

export function bytes32ToIntent(value: string): string {
  const hex = value.slice(2, 34);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}
