/**
 * Whether a string is a uuid, which every row id in this database is.
 *
 * Checked at the edge of a route rather than left to the query. Postgres refuses
 * a malformed uuid with an error rather than an empty result, so a mistyped link
 * would otherwise be a 500 and a round trip to the database for nothing.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
