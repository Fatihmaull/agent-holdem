/**
 * Colour is the only hue in the interface, and it always means one thing:
 * which agent something belongs to. Values are sampled from the chip art in
 * `public/chips`, so a stack on screen and its label are literally the same
 * colour rather than an approximation of it.
 */

export interface ChipColor {
  /** Matches the asset filename stem, `public/chips/<id>-top.png`. */
  id: string;
  name: string;
  hex: string;
  /** Text that stays legible on top of this chip. */
  ink: string;
}

/** Reserved for the signed-in player's own agent, at every table, always. */
const OWNER_COLOR: ChipColor = { id: 'white', name: 'White', hex: '#f2f2f2', ink: '#151c24' };

/**
 * Opponent colours, ordered by how far apart they read on the dark felt. Six-max
 * only ever needs the first five, so the most distinguishable ones get used most.
 */
export const OPPONENT_COLORS: ChipColor[] = [
  { id: 'red', name: 'Red', hex: '#f15a5a', ink: '#2a0f0f' },
  { id: 'green', name: 'Green', hex: '#60c771', ink: '#0d2612' },
  { id: 'lightblue', name: 'Light blue', hex: '#63b5db', ink: '#0b2430' },
  { id: 'yellow', name: 'Yellow', hex: '#dbd34b', ink: '#2b2a0c' },
  { id: 'purple', name: 'Purple', hex: '#9d68c9', ink: '#20112b' },
  { id: 'biege', name: 'Amber', hex: '#d69b56', ink: '#2c1c08' },
  { id: 'pink', name: 'Pink', hex: '#db8aa7', ink: '#2e1520' },
  { id: 'blue', name: 'Blue', hex: '#6261bf', ink: '#101033' },
  { id: 'gray', name: 'Grey', hex: '#727372', ink: '#f2f2f2' },
  { id: 'black', name: 'Slate', hex: '#515454', ink: '#f2f2f2' },
];

const ALL_COLORS: ChipColor[] = [OWNER_COLOR, ...OPPONENT_COLORS];

const BY_ID = new Map(ALL_COLORS.map((color) => [color.id, color]));

export function colorById(id: string): ChipColor {
  return BY_ID.get(id) ?? OPPONENT_COLORS[0];
}

/**
 * Picks a colour for a new agent, avoiding any already taken. White is never
 * handed out here because it belongs to whoever is watching.
 *
 * Past the tenth agent every colour is in use, so the least-used one is handed
 * out rather than always the first. That keeps the pool spread evenly, which is
 * what gives a table the best chance of seating six distinct colours.
 */
export function assignColor(taken: readonly string[]): ChipColor {
  const counts = new Map(OPPONENT_COLORS.map((color) => [color.id, 0]));
  for (const id of taken) {
    const seen = counts.get(id);
    if (seen !== undefined) counts.set(id, seen + 1);
  }

  let best = OPPONENT_COLORS[0];
  let fewest = Infinity;
  for (const color of OPPONENT_COLORS) {
    const seen = counts.get(color.id) ?? 0;
    if (seen < fewest) {
      fewest = seen;
      best = color;
    }
  }
  return best;
}
