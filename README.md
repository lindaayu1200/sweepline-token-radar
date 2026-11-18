# sweepline-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/lindaayu1200/sweepline-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/lindaayu1200/sweepline-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Sweepline** is a token launch radar: it reads one sealed snapshot of every protocol DefiLlama
tracks, prices each protocol that still records no token with a comparables-fitted value model,
and hands the reader a ranked board, a detail view and a costed farm plan for every row.

- **Value model** — a power law fitted in log space on the snapshot's own live-token comparables
  (robust-screened by median absolute deviation), with a growth multiplier from the seven-day
  change and an age multiplier from how long the protocol has run with no token. The fit is
  re-run once without each comp (leave-one-out) and the median absolute error is stated on the
  dashboard's model card.
- **Verdicts netted to $/hour** — every row's expected airdrop (a stated 0.50% allocation of the
  implied value) is netted against the plan's estimated hours, gas and capital drag, then graded
  against the board's own median: farm, thin or skip.
- **Farm plans** — seven concrete steps per protocol, each with a dollar cost and a duration,
  derived from the protocol's category, TVL tier and age. No protocol name is special-cased.
- **Dashboard** — an ink-teal instrument panel: stat strip, model card, comps scatter with the
  fitted line, search / chain / category / verdict filters, a sortable board, a detail drawer per
  protocol, and deep links (`#filter=thin&chain=Solana`, `#detail=<slug>`). Static page, no
  network, no framework.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Board: 200 rows, all 40 watchlist protocols covered, ranks 1..N by implied value. Board values
are this entry's own claim, never a make.fun statement and not investment advice.

---

<sub>Entered on [make.fun](https://make.fun/?ref=eh9bmgam&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
