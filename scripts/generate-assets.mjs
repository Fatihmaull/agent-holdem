#!/usr/bin/env node
/**
 * Generates the AgentHoldem visual asset pack.
 *
 * Every file this writes is drawn from scratch here — plain geometry, no
 * traced or copied artwork — and released under CC0 1.0 along with the rest
 * of the pack. Generating rather than vendoring means the deck is guaranteed
 * complete (52 cards, no gaps), internally consistent, and reproducible with
 * `npm run assets` if anything is ever tweaked.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../apps/web/public/assets');

const SUITS = [
  { key: 's', name: 'spades', colour: '#101720', symbol: '♠' },
  { key: 'h', name: 'hearts', colour: '#c02434', symbol: '♥' },
  { key: 'd', name: 'diamonds', colour: '#c02434', symbol: '♦' },
  { key: 'c', name: 'clubs', colour: '#101720', symbol: '♣' },
];

const RANKS = [
  { key: '2', name: '2', label: '2' },
  { key: '3', name: '3', label: '3' },
  { key: '4', name: '4', label: '4' },
  { key: '5', name: '5', label: '5' },
  { key: '6', name: '6', label: '6' },
  { key: '7', name: '7', label: '7' },
  { key: '8', name: '8', label: '8' },
  { key: '9', name: '9', label: '9' },
  { key: 'T', name: '10', label: '10' },
  { key: 'J', name: 'jack', label: 'J' },
  { key: 'Q', name: 'queen', label: 'Q' },
  { key: 'K', name: 'king', label: 'K' },
  { key: 'A', name: 'ace', label: 'A' },
];

const W = 240;
const H = 336;

/* ------------------------------------------------------------------ *
 * Suit glyphs, drawn in a 100x100 local box centred on (50,50)
 * ------------------------------------------------------------------ */

const SUIT_SHAPE = {
  hearts:
    '<path d="M50 88C20 62 6 47 6 33A21 21 0 0 1 50 22 21 21 0 0 1 94 33c0 14-14 29-44 55Z"/>',
  diamonds: '<path d="M50 5 92 50 50 95 8 50Z"/>',
  spades:
    '<path d="M50 6C50 6 10 37 10 58a20 20 0 0 0 34 14l-7 22h26l-7-22a20 20 0 0 0 34-14C90 37 50 6 50 6Z"/>',
  clubs:
    '<g><circle cx="50" cy="27" r="19"/><circle cx="26" cy="55" r="19"/><circle cx="74" cy="55" r="19"/>' +
    '<path d="M43 60h14l6 34H37Z"/></g>',
};

function pip(suit, cx, cy, size, flipped = false) {
  const scale = size / 100;
  const rotate = flipped ? ' rotate(180)' : '';
  return (
    `<g transform="translate(${round(cx)} ${round(cy)}) scale(${round(scale, 4)})${rotate} translate(-50 -50)">` +
    `${SUIT_SHAPE[suit]}</g>`
  );
}

function round(n, places = 2) {
  return Number(n.toFixed(places));
}

/* ------------------------------------------------------------------ *
 * Pip layouts — the standard arrangement for each number card
 * Coordinates are fractions of the card's inner area.
 * ------------------------------------------------------------------ */

const LAYOUTS = {
  '2': [[0.5, 0.14], [0.5, 0.86]],
  '3': [[0.5, 0.14], [0.5, 0.5], [0.5, 0.86]],
  '4': [[0.28, 0.14], [0.72, 0.14], [0.28, 0.86], [0.72, 0.86]],
  '5': [[0.28, 0.14], [0.72, 0.14], [0.5, 0.5], [0.28, 0.86], [0.72, 0.86]],
  '6': [
    [0.28, 0.14], [0.72, 0.14],
    [0.28, 0.5], [0.72, 0.5],
    [0.28, 0.86], [0.72, 0.86],
  ],
  '7': [
    [0.28, 0.14], [0.72, 0.14], [0.5, 0.32],
    [0.28, 0.5], [0.72, 0.5],
    [0.28, 0.86], [0.72, 0.86],
  ],
  '8': [
    [0.28, 0.14], [0.72, 0.14], [0.5, 0.32],
    [0.28, 0.5], [0.72, 0.5], [0.5, 0.68],
    [0.28, 0.86], [0.72, 0.86],
  ],
  '9': [
    [0.28, 0.12], [0.72, 0.12],
    [0.28, 0.37], [0.72, 0.37],
    [0.5, 0.5],
    [0.28, 0.63], [0.72, 0.63],
    [0.28, 0.88], [0.72, 0.88],
  ],
  '10': [
    [0.28, 0.12], [0.72, 0.12], [0.5, 0.25],
    [0.28, 0.37], [0.72, 0.37],
    [0.28, 0.63], [0.72, 0.63], [0.5, 0.75],
    [0.28, 0.88], [0.72, 0.88],
  ],
};

/* ------------------------------------------------------------------ *
 * Card faces
 * ------------------------------------------------------------------ */

const INNER = { x: 34, y: 46, w: W - 68, h: H - 92 };

function cornerIndex(rank, suit, colour, flipped) {
  const x = flipped ? W - 22 : 22;
  const y = flipped ? H - 26 : 26;
  const transform = flipped ? ` transform="rotate(180 ${x} ${y})"` : '';
  const fontSize = rank.label.length > 1 ? 30 : 34;
  return (
    `<g${transform} fill="${colour}">` +
    `<text x="${x}" y="${y}" font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" ` +
    `font-weight="700" text-anchor="middle" dominant-baseline="middle">${rank.label}</text>` +
    pip(suit.name, x, y + 26, 22) +
    '</g>'
  );
}

/**
 * Face cards use the classic double-headed court layout: one half drawn, the
 * other mirrored through the centre. A traced portrait would mean copying
 * someone else's artwork; a heraldic panel keeps the pack unambiguously CC0
 * while still reading as a court card at table size.
 */
function courtOrnament(rankKey, accent) {
  if (rankKey === 'K') {
    return (
      `<path d="M-30 4 -26-26 -13-9 0-30 13-9 26-26 30 4Z" fill="${accent}"/>` +
      `<rect x="-32" y="4" width="64" height="11" rx="3.5" fill="${accent}"/>` +
      `<circle cx="-26" cy="-30" r="4" fill="${accent}"/>` +
      `<circle cx="0" cy="-35" r="4.5" fill="${accent}"/>` +
      `<circle cx="26" cy="-30" r="4" fill="${accent}"/>`
    );
  }
  if (rankKey === 'Q') {
    return (
      `<path d="M-26 4 -20-22 0-14 20-22 26 4Z" fill="${accent}"/>` +
      `<rect x="-28" y="4" width="56" height="10" rx="3.5" fill="${accent}"/>` +
      `<circle cx="0" cy="-26" r="6" fill="${accent}"/>` +
      `<circle cx="-22" cy="-27" r="3.5" fill="${accent}"/>` +
      `<circle cx="22" cy="-27" r="3.5" fill="${accent}"/>`
    );
  }
  // Jack: a plumed helm rendered as a banded chevron.
  return (
    `<path d="M-24-18 24-18 15 6 -15 6Z" fill="${accent}"/>` +
    `<rect x="-27" y="6" width="54" height="10" rx="3.5" fill="${accent}"/>` +
    `<path d="M0-20 -14-34 0-30 14-34Z" fill="${accent}"/>`
  );
}

function courtPanel(rank, suit) {
  const { x, y, w, h } = INNER;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const accent = suit.colour;

  // One half, drawn once and mirrored through the centre.
  const half =
    `<g transform="translate(0 -34)">${courtOrnament(rank.key, accent)}</g>` +
    `<text y="26" font-family="Georgia, 'Times New Roman', serif" font-size="44" font-weight="700" ` +
    `fill="${accent}" text-anchor="middle" dominant-baseline="middle">${rank.label}</text>` +
    pip(suit.name, 0, 62, 26);

  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#fffdf7" ` +
    `stroke="${accent}" stroke-width="2.5" opacity="0.95"/>` +
    `<rect x="${x + 7}" y="${y + 7}" width="${w - 14}" height="${h - 14}" rx="7" fill="none" ` +
    `stroke="${accent}" stroke-width="1" opacity="0.4"/>` +
    `<line x1="${x + 7}" y1="${cy}" x2="${x + w - 7}" y2="${cy}" stroke="${accent}" ` +
    `stroke-width="1.5" opacity="0.4"/>` +
    `<g transform="translate(${cx} ${y + h * 0.27})">${half}</g>` +
    `<g transform="translate(${cx} ${y + h * 0.73}) rotate(180)">${half}</g>`
  );
}

function cardFace(rank, suit) {
  const colour = suit.colour;
  const parts = [];

  if (['J', 'Q', 'K'].includes(rank.key)) {
    parts.push(courtPanel(rank, suit));
  } else if (rank.key === 'A') {
    parts.push(pip(suit.name, W / 2, H / 2, 96));
  } else {
    const layout = LAYOUTS[rank.name];
    for (const [fx, fy] of layout) {
      parts.push(
        pip(
          suit.name,
          INNER.x + fx * INNER.w,
          INNER.y + fy * INNER.h,
          34,
          fy > 0.55,
        ),
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${rank.name} of ${suit.name}">
  <title>${capitalise(rank.name)} of ${suit.name}</title>
  <rect width="${W}" height="${H}" rx="18" fill="#fdfcf8"/>
  <rect x="2.5" y="2.5" width="${W - 5}" height="${H - 5}" rx="16" fill="none" stroke="#d8d3c4" stroke-width="3"/>
  <g fill="${colour}">
${parts.map((p) => `    ${p}`).join('\n')}
  </g>
  ${cornerIndex(rank, suit, colour, false)}
  ${cornerIndex(rank, suit, colour, true)}
</svg>
`;
}

function cardBack() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Card back">
  <title>Card back</title>
  <defs>
    <linearGradient id="backFill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1b2a4a"/>
      <stop offset="100%" stop-color="#0b1220"/>
    </linearGradient>
    <pattern id="lattice" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="24" height="24" fill="none"/>
      <path d="M12 0v24M0 12h24" stroke="#38bdf8" stroke-width="1.1" opacity="0.28"/>
      <circle cx="12" cy="12" r="2.6" fill="#38bdf8" opacity="0.35"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" rx="18" fill="url(#backFill)"/>
  <rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="12" fill="url(#lattice)"/>
  <rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="12" fill="none" stroke="#38bdf8" stroke-width="2" opacity="0.55"/>
  <g transform="translate(${W / 2} ${H / 2})">
    <circle r="42" fill="#0b1220" opacity="0.85"/>
    <circle r="42" fill="none" stroke="#38bdf8" stroke-width="2" opacity="0.7"/>
    <text y="2" font-family="Georgia, serif" font-size="34" font-weight="700" fill="#38bdf8"
      text-anchor="middle" dominant-baseline="middle">AH</text>
  </g>
</svg>
`;
}

/* ------------------------------------------------------------------ *
 * Chips
 * ------------------------------------------------------------------ */

const CHIPS = [
  { value: 1, body: '#f8fafc', edge: '#cbd5e1', ink: '#0f172a' },
  { value: 5, body: '#dc2626', edge: '#7f1d1d', ink: '#fff1f2' },
  { value: 25, body: '#16a34a', edge: '#14532d', ink: '#f0fdf4' },
  { value: 100, body: '#1e293b', edge: '#0f172a', ink: '#e2e8f0' },
  { value: 500, body: '#7c3aed', edge: '#4c1d95', ink: '#f5f3ff' },
  { value: 1000, body: '#f59e0b', edge: '#92400e', ink: '#451a03' },
];

function chip({ value, body, edge, ink }) {
  const spots = Array.from({ length: 6 }, (_, i) => {
    const angle = (i * 60 * Math.PI) / 180;
    const x = 50 + Math.cos(angle) * 39;
    const y = 50 + Math.sin(angle) * 39;
    return `<rect x="${round(x - 7)}" y="${round(y - 5)}" width="14" height="10" rx="2.5" fill="${ink}" opacity="0.85" transform="rotate(${i * 60} ${round(x)} ${round(y)})"/>`;
  }).join('\n    ');

  const label = value >= 1000 ? `${value / 1000}K` : String(value);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="${value} chip">
  <title>${value} chip</title>
  <circle cx="50" cy="50" r="48" fill="${edge}"/>
  <circle cx="50" cy="50" r="45" fill="${body}"/>
  <g>
    ${spots}
  </g>
  <circle cx="50" cy="50" r="31" fill="${edge}" opacity="0.18"/>
  <circle cx="50" cy="50" r="31" fill="none" stroke="${ink}" stroke-width="2" opacity="0.6"/>
  <text x="50" y="51" font-family="'Helvetica Neue', Arial, sans-serif" font-size="${label.length > 3 ? 20 : 24}"
    font-weight="700" fill="${ink}" text-anchor="middle" dominant-baseline="middle">${label}</text>
</svg>
`;
}

/* ------------------------------------------------------------------ *
 * Table felt
 * ------------------------------------------------------------------ */

function felt(name, inner, outer, rail) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 700" width="1200" height="700" role="img" aria-label="${name} poker felt">
  <title>${name} poker felt</title>
  <defs>
    <radialGradient id="felt" cx="50%" cy="45%" r="72%">
      <stop offset="0%" stop-color="${inner}"/>
      <stop offset="100%" stop-color="${outer}"/>
    </radialGradient>
    <pattern id="weave" width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="none"/>
      <path d="M0 0h6M0 3h6" stroke="#ffffff" stroke-width="0.5" opacity="0.035"/>
      <path d="M0 0v6M3 0v6" stroke="#000000" stroke-width="0.5" opacity="0.05"/>
    </pattern>
  </defs>
  <rect width="1200" height="700" fill="${outer}"/>
  <rect x="24" y="24" width="1152" height="652" rx="326" fill="${rail}"/>
  <rect x="42" y="42" width="1116" height="616" rx="308" fill="url(#felt)"/>
  <rect x="42" y="42" width="1116" height="616" rx="308" fill="url(#weave)"/>
  <rect x="42" y="42" width="1116" height="616" rx="308" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.12"/>
  <ellipse cx="600" cy="350" rx="392" ry="196" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.10"/>
</svg>
`;
}

function capitalise(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

function write(relative, content) {
  const target = resolve(OUT, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

let count = 0;
for (const suit of SUITS) {
  for (const rank of RANKS) {
    write(`cards/${suit.name}_${rank.name}.svg`, cardFace(rank, suit));
    count++;
  }
}
write('cards/back.svg', cardBack());
count++;

for (const spec of CHIPS) {
  write(`chips/chip_${spec.value}.svg`, chip(spec));
  count++;
}

write('felt/felt-green.svg', felt('Dark green', '#15503a', '#0a2b20', '#0f3d2c'));
write('felt/felt-slate.svg', felt('Navy slate', '#1e2f52', '#0a1224', '#16233f'));
count += 2;

write(
  'CREDITS.md',
  `# AgentHoldem asset pack

All assets in this directory are **CC0 1.0 Universal (public domain)**.

They are generated, not vendored: \`scripts/generate-assets.mjs\` draws every
file from plain SVG geometry authored for this project. Nothing here is traced
from or derived from third-party artwork, so the whole pack is unambiguously
free of licence obligations.

| Directory | Contents |
| --- | --- |
| \`cards/\` | 52 playing cards plus \`back.svg\`, named \`{suit}_{value}.svg\` |
| \`chips/\` | Chip denominations 1 / 5 / 25 / 100 / 500 / 1000 |
| \`felt/\` | Table surfaces in dark green and navy slate |

Regenerate with:

\`\`\`bash
npm run assets
\`\`\`

To the extent possible under law, the authors have waived all copyright and
related rights to these files. See <https://creativecommons.org/publicdomain/zero/1.0/>.
`,
);
count++;

console.log(`Generated ${count} CC0 asset files in ${OUT}`);
