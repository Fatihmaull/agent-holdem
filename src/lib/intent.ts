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
  // Checked rather than assumed. Anyone can call the vault with a bytes32 of
  // their choosing, and the result of this goes straight into a lookup on a
  // uuid column: a value that is not one belongs in a refusal, not in an error
  // from the database.
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`not a bytes32: ${value}`);

  const hex = value.slice(2, 34).toLowerCase();
  if (!/^0*$/.test(value.slice(34))) throw new Error(`not an intent identifier: ${value}`);

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}
