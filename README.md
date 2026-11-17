# Token Radar

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/RenzzHGE/token-radar-03/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/RenzzHGE/token-radar-03/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar for the [make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01) ($1,325): every protocol DefiLlama tracks, ranked by what its token launch would be worth, in a static web dashboard you can open offline.

## What it does

The snapshot seals 758 protocols (as of 2026-11-14). The radar finds the ones that still record **no token** and are **not a wrapped or staked product** of one that trades, then ranks them by implied launch value — TVL times the multiple the live market already pays their category — and shows, for each one, the model arithmetic and a concrete farm plan.

- **203 pre-token protocols** on the board, all **40 watchlist** slugs covered.
- **Top 3:** Steakhouse Financial ($959.4M implied), Sentora Curator ($929.4M), Gauntlet ($571.4M).
- **Detail view** per protocol: the value waterfall (TVL → category multiple → chain weight → crowding → growth → bleed → maturity → completeness → implied value), why it ranks where it does, and a 7-step farm plan with costs and times.
- **Farm plans** run on each protocol's **cheapest chain** (by gas), with a stake sized to TVL and a hold sized to age.
- **Model sandbox:** eight sliders re-rank the board live, using the same model that built `board.json` — the page recomputes every row, and with the shipped constants it returns exactly the number `board.json` carries (verified: 0 of 203 rows differ).
- **Live view** (40 largest live-token protocols) and a **calibration table** (per-category median and shrunk multiple, plus a chain-weight table) so the price is auditable.

## The model — radar-4

Radar-4 keeps radar-3's log-space calibration and log curves, and prices four signals radar-3 ignored or priced wrong:

1. **Chains are weighed, not counted.** Radar-3 paid `1 + 0.10 × ln(chains)` — a protocol on five chains nobody's TVL sits on scored like one on five live ones. Radar-4 weighs each chain by its share of the live set's TVL (Ethereum 40.1%, BSC 13.5%, Base 10.2% …) and pays `1 + 0.70 × summed weight`, capped at 1.35. A protocol on Ethereum alone pays 1.28; one on five 0.5% chains pays 1.02. This is the biggest ranking change: 182 of 203 rows move.
2. **Category crowding.** A launch into a category with 34 pre-token rivals is not worth the same as one into a category with 1. Radar-4 discounts by `1 / (1 + 0.06 × ln(n))`, n the count of rankable protocols in the category — 0.83 at n = 34 (Risk Curators), 1.00 at n = 1.
3. **A bleeding penalty.** A fast TVL fall is louder than a fast rise: below −20% in seven days, radar-4 cuts by up to a further 15% (`1 − 0.15 × min(1, (change + 20) / 50)`), on top of the linear growth term. 5 rows carry this penalty on the local snapshot.
4. **A stricter completeness haircut.** Radar-3 cut 3% for a missing seven-day change only. Radar-4 cuts a further 2% when the listing date is unreported — an age the snapshot never verified is not free either. 9 rows carry a haircut below 1 on the local snapshot.

The same function scores every protocol; the dashboard recomputes each row from the same model, so the detail view shows the same number `board.json` carries. Implied value is an estimate, not a price.

## How the farm is priced

Gas per chain (USD): Ethereum $8, Base/Polygon/Avalanche/Optimism/zkSync/Linea/Scroll $0.5, Binance/Blast/Fantom/Gnosis $0.3, Arbitrum/Tron $1, Cosmos $0.1, Solana/Sui/Aptos/Near/Sei $0.05, default $2. The farm uses the protocol's cheapest chain. Stake: $150 (TVL ≥ $1B), $100 (≥ $100M), else $50. Hold: 30 days (age ≥ 1y), 45 days (≥ 180d), else 60 days. Total gas ≈ (1 setup + 1 weekly + 1 claim) × chain gas.

## Run it

```sh
node main.ts --input snapshot.json   # writes board.json, data.js, dashboard/, dossier.json to out/
```

`main.ts` reads `/input/snapshot.json` (or `--input <file>`), writes to `/output` (or `MAKEFUN_OUTPUT_DIR`). Node 22 stdlib only, no network. Open `out/dashboard/index.html` in a browser — it loads `../data.js` and needs no server, though any static server works.

## Layout

- `main.ts` — entrypoint: reads the snapshot, builds the board, writes `board.json`, `data.js`, copies `dashboard/` + `screenshots/`, writes `dossier.json`.
- `lib/model.ts` — radar-4: calibration, ranking, farm plans.
- `dashboard/` — the static dashboard: `index.html`, `app.css`, `app.js` (renders the board, detail dialog, sandbox; recomputes the model in the page).
- `screenshots/` — three real renders: board, detail view, watchlist-filtered board.
- `kit/` — the fresh competition kit (RULES.txt, competition.yaml).
- `old-entry/` — the previous entry, kept only as a reference for comparison.

## License

MIT. See [LICENSE](LICENSE).
