# AgentHoldem asset pack

All assets in this directory are **CC0 1.0 Universal (public domain)**.

They are generated, not vendored: `scripts/generate-assets.mjs` draws every
file from plain SVG geometry authored for this project. Nothing here is traced
from or derived from third-party artwork, so the whole pack is unambiguously
free of licence obligations.

| Directory | Contents |
| --- | --- |
| `cards/` | 52 playing cards plus `back.svg`, named `{suit}_{value}.svg` |
| `chips/` | Chip denominations 1 / 5 / 25 / 100 / 500 / 1000 |
| `felt/` | Table surfaces in dark green and navy slate |

Regenerate with:

```bash
npm run assets
```

To the extent possible under law, the authors have waived all copyright and
related rights to these files. See <https://creativecommons.org/publicdomain/zero/1.0/>.
