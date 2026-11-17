// Token Radar — entrypoint (model "radar-4").
//
// Reads the sealed snapshot, ranks every rankable pre-token protocol by
// its implied launch value, and writes the run's outputs:
//
//   out/board.json    the ranked board, with each row's model arithmetic,
//                     its farm chain and cost, and its seven-step plan
//   out/data.js       the same data flattened for the dashboard page
//   out/dashboard/    a copy of the dashboard page
//   out/screenshots/  a copy of the screenshots
//   out/dossier.json  the evidence pack, written last
//
// Usage (from the repository root):
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// Node 22 or newer, standard library only, no network.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRadar, MODEL_PARAMS, type BoardRow, type Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// The dashboard's row: everything the page needs, flattened so it never
// has to guess. The model breakdown is carried whole, so the detail view
// can show the same arithmetic board.json was built from.
function flatRow(row: BoardRow) {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_multiple: row.model.base_multiple,
    category_median: row.model.category_median,
    calibration_n: row.model.calibration_n,
    chain_weight: row.model.chain_weight,
    chain_multiplier: row.model.chain_multiplier,
    crowding: row.model.crowding,
    crowding_n: row.model.crowding_n,
    growth_pct: row.model.growth_pct,
    growth_multiplier: row.model.growth_multiplier,
    bleed: row.model.bleed,
    maturity_multiplier: row.model.maturity_multiplier,
    completeness: row.model.completeness,
    farm_chain: row.farm_chain,
    farm_cost_usd: row.farm_cost_usd,
    farm_weeks: row.farm_weeks,
    on_watchlist: row.on_watchlist,
  };
}

// The gate's own shape, checked here before anything is written: ranks
// 1..N once each, implied value never rising as rank ascends, every
// watchlist slug covered, and every row's farm plan 3-12 steps of
// 20-600 characters each.
function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, need 100-4000`;
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.rank !== i + 1) return `row ${r.slug} has rank ${r.rank}, expected ${i + 1}`;
    if (i > 0 && rows[i - 1].implied_value_usd < r.implied_value_usd) {
      return `implied value rises from rank ${i} to ${i + 1}`;
    }
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (!r.name) return `row ${r.slug} has no name`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `row ${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${r.slug} has ${r.farm_steps.length} farm steps, need 3-12`;
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is not on the board`;
  }
  return null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const input = flagValue(argv, "--input") ?? join(HERE, "..", "input", "snapshot.json");
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? flagValue(argv, "--out") ?? join(HERE, "out");
  const snapshotPath = resolve(input);

  if (!existsSync(snapshotPath)) {
    process.stderr.write(`token radar: no snapshot at ${snapshotPath}\n`);
    process.exit(2);
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  const result = buildRadar(snapshot, MODEL_PARAMS);

  const issue = boardIssue(result.rows, snapshot);
  if (issue !== null) {
    process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "dashboard"), { recursive: true });
  mkdirSync(join(outDir, "screenshots"), { recursive: true });

  writeFileSync(join(outDir, "board.json"), JSON.stringify({ rows: result.rows }));

  const payload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: result.params,
    model_version: "radar-4",
    watchlist_size: result.watchlist_size,
    board_size: result.rows.length,
    early_size: result.early_size,
    live_size: result.live.length,
    live_calibration_size: result.calibration.reduce((sum, c) => sum + c.n, 0),
    global_median: result.global_median,
    calibration: result.calibration,
    chain_weights: result.chain_weights,
    category_counts: result.category_counts,
    rows: result.rows.map(flatRow),
    live: result.live,
  };
  writeFileSync(join(outDir, "data.js"), `window.RADAR=${JSON.stringify(payload)};\n`);

  for (const file of ["index.html", "app.css", "app.js"]) {
    copyFileSync(join(HERE, "dashboard", file), join(outDir, "dashboard", file));
  }
  cpSync(join(HERE, "screenshots"), join(outDir, "screenshots"), { recursive: true });

  const dossier = buildDossier(outDir, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  // buildDossier returns the canonical JSON as a Uint8Array — write those
  // bytes directly. JSON.stringify on a Uint8Array would expand every byte
  // into a {"0":123,...} object (6.8MB of junk).
  writeFileSync(join(outDir, "dossier.json"), dossier);

  const liveCount = snapshot.protocols.filter((p) => p.mcap_usd !== null).length;
  console.log(`${snapshot.protocols.length} protocols, ${result.watchlist_size} watchlist, ${result.rows.length} rows`);
  console.log(
    `${result.early_size} early, ${result.live.length} live shown, ${payload.live_calibration_size} live calibrate, ` +
      `global median ${Number(result.global_median.toFixed(3))}, ${liveCount} live in snapshot`,
  );
  console.log(`top: ${result.rows[0].name} $${result.rows[0].implied_value_usd.toLocaleString("en-US")}`);
}

main();
