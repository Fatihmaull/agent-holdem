/**
 * Where a visitor goes to get the things this product cannot give them.
 *
 * A stranger arriving with an empty wallet cannot buy a chip, cannot seat an
 * agent, and cannot find out why without leaving. That is the first thing to
 * fix on any page that mentions money, so the links live in one place rather
 * than being retyped wherever somebody remembered them.
 *
 * Pure, and shared by both halves: the notice bar renders on the client, the
 * copy is also read on the server.
 */

/** Free testnet tBNB. Without this nothing else on the site is reachable. */
export const FAUCET_URL = 'https://www.bnbchain.org/en/testnet-faucet';

/** Where a transaction can be looked up by anyone who does not trust us. */
export const EXPLORER_URL = 'https://testnet.bscscan.com';

export function explorerTx(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

/**
 * The sentence that has to be somewhere a visitor cannot miss.
 *
 * "Testnet" means nothing to most people, and neither does tBNB. Saying it
 * costs nothing real, in those words, is the difference between a product
 * somebody trusts and one they assume is trying to take their money.
 */
export const TESTNET_LINE = 'Testnet only — chips are bought with free test tokens and are not real money.';
