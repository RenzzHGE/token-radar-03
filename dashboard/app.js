// Token Radar — dashboard (model "radar-4").
//
// A static page: it reads window.RADAR (written by main.ts) and renders
// the board, the live view, the calibration table, the detail dialog and
// the model sandbox. The page recomputes every implied value from the
// same model that built board.json, so the detail view can show that its
// number is the same number board.json carries, and it regenerates every
// farm plan from the same generator the build used, so the plan the
// detail view shows is the plan board.json carries.
//
// radar-4: the category multiple is shrunk in log space (a geometric
// multiple, robust to a live protocol at 10x); chains are weighted by
// their share of the live set's TVL, not counted; a crowded category
// discounts the launch; a fast TVL bleed is penalised beyond the linear
// growth term; maturity grows with ln(1 + age/365); a missing seven-day
// change costs 3% and an unreported listing date a further 2%. The farm
// happens on the protocol's cheapest chain.

(function () {
  "use strict";

  const D = window.RADAR;
  if (!D) return;

  const $ = (id) => document.getElementById(id);
  const rows = D.rows;
  const live = D.live;
  const calibration = D.calibration;
  const params = D.model;

  // ---- formatting -------------------------------------------------------

  function money(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + Math.round(v);
  }

  function ageText(ageDays) {
    const age = ageDays === null || ageDays === undefined ? 365 : ageDays;
    if (age >= 365) return (age / 365).toFixed(1) + "y";
    return age + "d";
  }

  function pctText(change) {
    if (change === null || change === undefined) return "—";
    return (change >= 0 ? "+" : "") + change.toFixed(2) + "%";
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- model (same function as the build) -------------------------------

  function round4(x) {
    return Math.round(x * 10000) / 10000;
  }

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  // Log-space calibration: the median of log(ratio) per category, shrunk
  // toward the global log-median, then exponentiated. D.global_median is
  // the exponentiated global log-median, so log of it is the global log.
  function baseMultiple(category) {
    const entry = calibration.find((c) => c.category === category);
    const gLog = Math.log(D.global_median);
    if (!entry) return round4(D.global_median);
    const medLog = Math.log(entry.median);
    const shrunkLog = (entry.n * medLog + params.shrink_prior * gLog) / (entry.n + params.shrink_prior);
    return round4(clamp(Math.exp(shrunkLog), params.winsor_low * D.global_median, params.winsor_high * D.global_median));
  }

  // Chain weight: each chain's share of the live set's TVL, summed over
  // the protocol's chains and paid 1 + 0.70 x that sum, capped at 1.35.
  // A chain the live set never lists weighs 0.
  function chainWeight(chains) {
    let sum = 0;
    for (const c of chains) sum += (D.chain_weights && D.chain_weights[c]) || 0;
    return sum;
  }

  function chainMultiplier(chains) {
    return round4(Math.min(1 + params.chain_weight_step * chainWeight(chains), params.chain_cap));
  }

  // Category crowding: 1 / (1 + 0.06 x ln(n)), n the snapshot's count of
  // rankable protocols in the category.
  function crowdingMultiplier(category) {
    const n = (D.category_counts && D.category_counts[category]) || 1;
    return round4(1 / (1 + params.crowding_strength * Math.log(Math.max(1, n))));
  }

  // A fast bleed is louder than a fast rise: below -20% in seven days,
  // cut by up to a further 15%.
  function bleedMultiplier(change) {
    if (change === null || change === undefined || change >= params.bleed_threshold) return 1;
    const depth = Math.min(1, (-change - Math.abs(params.bleed_threshold)) / 50);
    return round4(1 - params.bleed_strength * depth);
  }

  function growthMultiplier(change) {
    const pct = change === null || change === undefined ? 0 : change;
    const bounded = clamp(pct, params.growth_floor, params.growth_cap);
    return round4(1 + (params.growth_weight * bounded) / 100);
  }

  function maturityMultiplier(ageDays) {
    const age = ageDays === null || ageDays === undefined ? params.unknown_age_days : ageDays;
    const days = Math.min(age, params.maturity_days);
    const frac = Math.log(1 + days / 365) / Math.log(1 + params.maturity_days / 365);
    return round4(params.maturity_floor + params.maturity_range * frac);
  }

  // Completeness: a missing seven-day change costs 3%, and an unreported
  // listing date a further 2%.
  function completeness(row) {
    let f = 1;
    if (row.change_7d === null || row.change_7d === undefined) f *= params.missing_data_factor;
    if (row.listed_at === null || row.listed_at === undefined) f *= params.unknown_age_factor;
    return f;
  }

  // Recompute a row's implied value from its stored inputs. With the
  // shipped constants this returns exactly the number board.json carries.
  // The sandbox passes its own constants in `over`.
  function recompute(row, over) {
    const p = over || params;
    const entry = calibration.find((c) => c.category === row.category);
    const gLog = Math.log(D.global_median);
    let base;
    if (!over && entry) {
      // The shipped multiple, exactly as the build stored it: recomputing
      // it from the table's rounded median flips a rounding boundary for
      // a few rows (the build shrinks from the full-precision median).
      base = entry.multiple;
    } else if (!entry) {
      base = round4(D.global_median);
    } else {
      const medLog = Math.log(entry.median);
      const shrunkLog = (entry.n * medLog + p.shrink_prior * gLog) / (entry.n + p.shrink_prior);
      base = round4(clamp(Math.exp(shrunkLog), p.winsor_low * D.global_median, p.winsor_high * D.global_median));
    }
    // The helpers read the shipped params; under a sandbox override the
    // same arithmetic is re-run here with `p`. The multiplier is built
    // from the RAW chain-weight sum, exactly as the build does it; the
    // rounded weight below is display only.
    const cwRaw = row.chains.reduce((s, c) => s + ((D.chain_weights && D.chain_weights[c]) || 0), 0);
    const cw = round4(cwRaw);
    const chain = round4(Math.min(1 + p.chain_weight_step * cwRaw, p.chain_cap));
    const cn = (D.category_counts && D.category_counts[row.category]) || 1;
    const crowding = round4(1 / (1 + p.crowding_strength * Math.log(Math.max(1, cn))));
    const pct = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    const growth = round4(1 + (p.growth_weight * clamp(pct, p.growth_floor, p.growth_cap)) / 100);
    let bleed = 1;
    if (row.change_7d !== null && row.change_7d !== undefined && row.change_7d < p.bleed_threshold) {
      bleed = round4(1 - p.bleed_strength * Math.min(1, (-row.change_7d - Math.abs(p.bleed_threshold)) / 50));
    }
    const age = row.age_days === null || row.age_days === undefined ? p.unknown_age_days : row.age_days;
    const days = Math.min(age, p.maturity_days);
    const frac = Math.log(1 + days / 365) / Math.log(1 + p.maturity_days / 365);
    const maturity = round4(p.maturity_floor + p.maturity_range * frac);
    let comp = 1;
    if (row.change_7d === null || row.change_7d === undefined) comp *= p.missing_data_factor;
    if (row.listed_at === null || row.listed_at === undefined) comp *= p.unknown_age_factor;
    return {
      base,
      chain,
      chain_weight: cw,
      crowding,
      crowding_n: cn,
      growth,
      bleed,
      maturity,
      completeness: comp,
      implied: Math.round(row.tvl_usd * base * chain * crowding * growth * bleed * maturity * comp),
    };
  }

  // ---- farm plans (same generator as the build) -------------------------

  const GAS = {
    Ethereum: 8, Base: 0.5, Polygon: 0.5, Avalanche: 0.5, Solana: 0.05,
    Sui: 0.05, Aptos: 0.05, Binance: 0.3, Arbitrum: 1, Tron: 1,
    Optimism: 0.5, zkSync: 0.5, Linea: 0.5, Scroll: 0.5, Blast: 0.3,
    Fantom: 0.3, Gnosis: 0.3, Cosmos: 0.1, Near: 0.05, Sei: 0.05,
  };

  function gasFor(chain) {
    return GAS[chain] !== undefined ? GAS[chain] : 2;
  }

  function gasText(chain) {
    return "$" + gasFor(chain);
  }

  function cheapestChain(chains) {
    let best = chains[0];
    for (const c of chains) if (gasFor(c) < gasFor(best)) best = c;
    return best;
  }

  function farmStake(tvl) {
    if (tvl >= 1000000000) return 150;
    if (tvl >= 100000000) return 100;
    return 50;
  }

  function holdDays(ageDays) {
    if (ageDays === null || ageDays === undefined || ageDays >= 365) return 30;
    if (ageDays >= 180) return 45;
    return 60;
  }

  function farmCost(gas, hold) {
    const weeks = Math.max(1, Math.ceil(hold / 7));
    return Math.round((1 + weeks + 1) * gas * 100) / 100;
  }

  function farmVoice(category) {
    switch (category) {
      case "Risk Curators": case "Onchain Capital Allocator":
        return { action: "vault", weekly: "add a little more or vote" };
      case "Lending": case "CDP": case "CDP Manager": case "Collateral Markets": case "Uncollateralized Lending":
        return { action: "lend", weekly: "supply, borrow or repay a little" };
      case "Dexs": case "Indexes":
        return { action: "liquidity", weekly: "swap, add liquidity or claim rewards" };
      case "Yield": case "Yield Aggregator": case "Leveraged Farming":
        return { action: "top-vault", weekly: "swap, add liquidity or claim rewards" };
      case "RWA":
        return { action: "mint-yield", weekly: "mint, hold or claim yield" };
      case "Derivatives": case "Interest Rate Derivatives":
        return { action: "margin", weekly: "open or close one small position" };
      case "Restaking": case "Staking Pool": case "Staking":
        return { action: "stake", weekly: "stake a little more or claim rewards" };
      case "Prediction Market":
        return { action: "predict", weekly: "place or settle one market position" };
      case "Insurance":
        return { action: "cover", weekly: "deposit, swap or vote" };
      case "Stablecoin Wrapper": case "Dual-Token Stablecoin": case "Algo-Stables":
        return { action: "stable", weekly: "mint, hold or claim yield" };
      case "Options":
        return { action: "options", weekly: "open or close one small options position" };
      case "Perps":
        return { action: "perps", weekly: "open or close one small perpetual position" };
      case "Farm":
        return { action: "farm", weekly: "harvest or compound the rewards" };
      case "Reserve Currency":
        return { action: "bond", weekly: "bond, stake or claim rewards" };
      case "Privacy":
        return { action: "shield", weekly: "shield or transfer a small amount" };
      case "Gaming":
        return { action: "play", weekly: "play one session or complete a quest" };
      case "NFT Marketplace":
        return { action: "trade", weekly: "list, buy or bid on one item" };
      case "NFT Lending":
        return { action: "nft-lend", weekly: "lend, borrow or repay a little" };
      case "Oracle":
        return { action: "oracle", weekly: "stake, delegate or vote" };
      case "Cross Chain":
        return { action: "bridge", weekly: "bridge a small amount or vote" };
      case "Services":
        return { action: "use", weekly: "use one service or complete a task" };
      case "Launchpad":
        return { action: "launch", weekly: "stake, vote or join one sale" };
      case "Payments":
        return { action: "pay", weekly: "send or receive one payment" };
      case "Social":
        return { action: "engage", weekly: "post, tip or complete a task" };
      default:
        return { action: "deposit", weekly: "deposit, swap or vote" };
    }
  }

  function farmMain(row, stake) {
    const chain = row.farm_chain;
    const gas = gasText(chain);
    const voice = farmVoice(row.category);
    const base = {
      vault: "Put $" + stake + " into a " + row.name + " vault on " + chain + " and hold the shares.",
      lend: "Lend $" + stake + " of USDC to " + row.name + " on " + chain + " and leave the position open.",
      liquidity: "Add $" + stake + " of liquidity to " + row.name + "'s main pool on " + chain + " and leave the position open.",
      "top-vault": "Put $" + stake + " of USDC into " + row.name + "'s best-yielding vault on " + chain + " and leave the position open.",
      "mint-yield": "Mint $" + stake + " of the protocol's yield-bearing asset on " + chain + " and hold it.",
      margin: "Post $" + stake + " of USDC as margin on " + row.name + " and open one small hedged position.",
      stake: "Stake $" + stake + " of the chain's staking asset through " + row.name + " and keep the receipt.",
      predict: "Fund $" + stake + " and open one market position on " + row.name + ".",
      cover: "Buy $" + stake + " of cover from " + row.name + " on " + chain + " and keep the policy.",
      stable: "Mint or deposit $" + stake + " of the stable asset through " + row.name + " on " + chain + ".",
      options: "Buy one small " + row.name + " options position on " + chain + " and hold it to expiry.",
      perps: "Open one small hedged perpetual position on " + row.name + " on " + chain + ".",
      farm: "Deposit $" + stake + " of USDC into " + row.name + "'s farm on " + chain + " and leave the position open.",
      bond: "Bond $" + stake + " of the reserve asset through " + row.name + " on " + chain + " and hold the bond.",
      shield: "Shield $" + stake + " through " + row.name + " on " + chain + " and keep the shielded balance.",
      play: "Play one session of " + row.name + " on " + chain + " and keep the account active.",
      trade: "List or buy one item on " + row.name + " on " + chain + " and keep the account active.",
      "nft-lend": "Lend $" + stake + " against an NFT on " + row.name + " on " + chain + " and leave the loan open.",
      oracle: "Stake $" + stake + " with " + row.name + " on " + chain + " and keep the stake delegated.",
      bridge: "Bridge $" + stake + " through " + row.name + " to " + chain + " and keep the position on the destination chain.",
      use: "Use " + row.name + " on " + chain + " with $" + stake + " and keep the account active.",
      launch: "Stake $" + stake + " with " + row.name + " on " + chain + " and join one sale or vote.",
      pay: "Send $" + stake + " through " + row.name + " on " + chain + " and keep the account active.",
      engage: "Engage with " + row.name + " on " + chain + " and complete one task with $" + stake + " staked.",
      deposit: "Deposit $" + stake + " of USDC into " + row.name + " on " + chain + " and keep the position open.",
    };
    return (base[voice.action] || base.deposit) +
      " Cost: $" + stake + " of capital and about " + gas + " of gas on " + chain + ". Time: 15 minutes to set up.";
  }

  function farmSteps(row) {
    const chain = row.farm_chain;
    const gas = gasText(chain);
    const stake = farmStake(row.tvl_usd);
    const voice = farmVoice(row.category);
    const hold = holdDays(row.age_days);
    const chainNote = row.chains.length > 1
      ? " " + row.name + " also runs on " + row.chains.filter((c) => c !== chain).slice(0, 3).join(", ") +
        ", but " + chain + " is the cheapest gas, so the farm happens there."
      : "";
    return [
      "Set up a fresh wallet just for this farm, fund it only with the amount you plan to use, and keep its recovery phrase offline. Cost: about " + gas + " of gas for the first transaction. Time: 5 minutes.",
      farmMain(row, stake) + chainNote,
      "Do one qualifying action each week — " + voice.weekly + ". Cost: about " + gas + " of gas a week. Time: 10 minutes a week.",
      "Keep the position open for at least " + hold + " days so it shows up in more than one snapshot. Cost: the $" + stake + " stays in the position. Time: " + hold + " days.",
      "Visit " + row.name + "'s own points or rewards page, connect the same wallet, and finish every task it lists. Cost: no fee to check, and never pay to claim. Time: 10 minutes.",
      "If a token or claim opens, follow only the link the protocol itself publishes, verify the token contract in the chain explorer before approving anything, and never sign a blind approval. Cost: the claim gas only, about " + gas + ". Time: 15 minutes.",
      "Record the wallet, the dates and every transaction in a farm log, so you can repeat the position or unwind it later. Cost: nothing but the log. Time: 5 minutes.",
    ];
  }

  // ---- header, hero, facts ----------------------------------------------

  function renderMeta() {
    $("top-meta").innerHTML =
      "<span>Snapshot <b>" + esc(D.as_of) + "</b></span>" +
      "<span>Source <b>" + esc(D.source.split(" ")[0]) + "</b></span>" +
      "<span>Model <b>" + esc(D.model_version) + "</b></span>";
  }

  function renderHero() {
    const top = rows.slice(0, 10);
    const max = top[0].implied_value_usd;
    const cx = 170;
    const cy = 130;
    let dots = "";
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const angle = (i / top.length) * Math.PI * 2 - Math.PI / 2;
      const radius = i === 0 ? 0 : 28 + (Math.log(r.implied_value_usd) / Math.log(max)) * 78;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const size = 4 + 7 * (r.implied_value_usd / max);
      dots +=
        '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + size.toFixed(1) +
        '" fill="' + (i === 0 ? "#f5b942" : "#8a94a8") + '" opacity="' + (i === 0 ? "1" : "0.75") + '">' +
        "<title>" + esc(r.name) + " — " + money(r.implied_value_usd) + "</title></circle>";
    }
    const rings = [34, 68, 102]
      .map((r) => '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#232e47" stroke-width="1"/>')
      .join("");
    $("hero").innerHTML =
      '<figure class="scope"><svg viewBox="0 0 340 260" role="img" aria-label="Radar scope of the top 10 protocols by implied value">' +
      rings + dots + "</svg>" +
      "<figcaption>The top 10 by implied value, the strongest at the centre. <b>" +
      esc(top[0].name) + "</b> leads at <b>" + money(top[0].implied_value_usd) + "</b>.</figcaption></figure>" +
      '<div class="lede"><h1>The next launches, priced by the market that is already live</h1>' +
      "<p>Every pre-token protocol in the snapshot, ranked by what its token launch would be worth: " +
      "TVL times the multiple the live market pays its category, in log space. The strongest first.</p>" +
      '<ol class="top-ten" id="top-ten">' +
      top
        .map((r) => {
          const w = Math.max(2, Math.round((r.implied_value_usd / max) * 100));
          return '<li data-slug="' + esc(r.slug) + '"><span class="rank num">' + r.rank +
            '</span><span class="name">' + esc(r.name) + '</span><span class="cat">' + esc(r.category) +
            '</span><span class="val num">' + money(r.implied_value_usd) + '</span><span class="bar"><i style="width:' + w + '%"></i></span></li>';
        })
        .join("") +
      "</ol></div>";
    $("top-ten").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-slug]");
      if (li) openDetail(li.getAttribute("data-slug"));
    });
  }

  function renderFacts() {
    $("facts").innerHTML =
      '<div class="fact"><div class="label">Watchlist covered</div><div class="big num">' + D.watchlist_size + " / " + D.watchlist_size +
      '</div><div class="note">every watchlist slug is on the board</div></div>' +
      '<div class="fact"><div class="label">Global median multiple</div><div class="big num">' + D.global_median.toFixed(3) +
      '</div><div class="note">geometric mcap / TVL across the live set</div></div>' +
      '<div class="fact"><div class="label">Pre-token board</div><div class="big num">' + D.board_size +
      '</div><div class="note">' + D.early_size + " beyond the watchlist</div></div>" +
      '<div class="fact"><div class="label">Live protocols calibrating</div><div class="big num">' + D.live_calibration_size +
      '</div><div class="note">their multiples set the price</div></div>';
  }

  // ---- board ------------------------------------------------------------

  let sortKey = "implied";
  let sortDir = -1;
  let sandbox = null;

  function chainLabel(chains) {
    if (chains.length <= 2) return chains.join(", ");
    return chains.slice(0, 2).join(", ") + " +" + (chains.length - 2);
  }

  function currentRows() {
    let list = rows.slice();
    if (sandbox) {
      list = list.map((r) => {
        const c = recompute(r, sandbox);
        return Object.assign({}, r, { implied_value_usd: c.implied, base_multiple: c.base });
      });
      list.sort((a, b) => b.implied_value_usd - a.implied_value_usd);
      list.forEach((r, i) => { r.rank = i + 1; });
    }
    const q = $("q").value.trim().toLowerCase();
    const cat = $("cat").value;
    const chain = $("chain").value;
    const minTvl = Number($("min-tvl").value);
    const minImp = Number($("min-imp").value);
    const watchOnly = $("watch-only").checked;
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q) ||
          r.chains.some((c) => c.toLowerCase().includes(q)),
      );
    }
    if (cat) list = list.filter((r) => r.category === cat);
    if (chain) list = list.filter((r) => r.chains.includes(chain));
    if (minTvl) list = list.filter((r) => r.tvl_usd >= minTvl);
    if (minImp) list = list.filter((r) => r.implied_value_usd >= minImp);
    if (watchOnly) list = list.filter((r) => r.on_watchlist);
    const key = sortKey;
    list.sort((a, b) => {
      const av = key === "chg" ? a.change_7d ?? 0 : key === "age" ? a.age_days ?? 365 : key === "mult" ? a.base_multiple : a[key === "implied" ? "implied_value_usd" : key === "tvl" ? "tvl_usd" : "rank"];
      const bv = key === "chg" ? b.change_7d ?? 0 : key === "age" ? b.age_days ?? 365 : key === "mult" ? b.base_multiple : b[key === "implied" ? "implied_value_usd" : key === "tvl" ? "tvl_usd" : "rank"];
      return (av - bv) * sortDir;
    });
    return list;
  }

  function renderBoard() {
    const list = currentRows();
    const max = Math.max.apply(null, list.map((r) => r.implied_value_usd).concat([1]));
    $("board-body").innerHTML = list
      .map((r) => {
        const chg = r.change_7d;
        const chgCls = chg === null || chg === undefined ? "" : chg >= 0 ? "up" : "down";
        const width = Math.max(2, Math.round((r.implied_value_usd / max) * 100));
        const wl = r.on_watchlist ? ' <span class="pill">watchlist</span>' : "";
        return (
          '<tr data-slug="' + esc(r.slug) + '">' +
          '<td class="num">' + r.rank + "</td>" +
          '<td><span class="name">' + esc(r.name) + "</span>" + wl + '<br><span class="sub">' +
          esc(r.category) + " on " + esc(chainLabel(r.chains)) + "</span></td>" +
          '<td class="num">' + money(r.tvl_usd) + "</td>" +
          '<td class="num ' + chgCls + '">' + pctText(chg) + "</td>" +
          '<td class="num">' + ageText(r.age_days) + "</td>" +
          '<td class="num">×' + r.base_multiple.toFixed(3) + "</td>" +
          '<td class="num"><span class="up">' + money(r.implied_value_usd) + '</span><span class="bar"><i style="width:' + width + '%"></i></span></td>' +
          '<td><span class="farmcell">Farm on <b>' + esc(r.farm_chain) + "</b><br>≈$" + r.farm_cost_usd + " gas · " + r.farm_weeks + "w</span></td></tr>"
        );
      })
      .join("");
    $("count").textContent = list.length + " rows shown";
    $("hint").textContent = sandbox
      ? "Sandbox on: the board is re-ranked under your constants. Select a row for its model and farm plan."
      : "Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.";
    document.querySelectorAll("#board thead th[data-sort]").forEach((th) => {
      th.textContent = th.textContent.replace(/ [▾▴]$/, "");
      if (th.getAttribute("data-sort") === sortKey) {
        th.textContent += sortDir === -1 ? " ▾" : " ▴";
      }
    });
  }

  function renderAlt(kind) {
    const alt = $("alt-view");
    const board = $("board");
    if (kind === "board") {
      alt.hidden = true;
      board.hidden = false;
      return;
    }
    board.hidden = true;
    alt.hidden = false;
    alt.className = "alt";
    if (kind === "live") {
      alt.innerHTML =
        "<p class=\"hint\">Live-token protocols, largest market cap first. Their multiples are what calibrate the model.</p>" +
        "<table><thead><tr><th>#</th><th>Protocol</th><th>Category</th><th class=\"num\">TVL</th><th class=\"num\">Market cap</th><th class=\"num\">Multiple</th></tr></thead><tbody>" +
        live
          .map(
            (r, i) =>
              "<tr><td class=\"num\">" + (i + 1) + '</td><td><span class="name">' + esc(r.name) +
              '</span><br><span class="sub">' + esc(r.category) + " on " + esc(chainLabel(r.chains)) + "</span></td>" +
              "<td>" + esc(r.category) + '</td><td class="num">' + money(r.tvl_usd) +
              '</td><td class="num">' + money(r.mcap_usd) + '</td><td class="num">×' + r.multiple.toFixed(4) + "</td></tr>",
          )
          .join("") +
        "</tbody></table>";
      $("count").textContent = live.length + " rows shown";
    } else {
      // Calibration: the category table, then the chain weights that
      // radar-4 prices chains by — each chain's share of the live set's
      // TVL, computed from the snapshot's live protocols.
      const weights = Object.entries(D.chain_weights || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
      alt.innerHTML =
        "<p class=\"hint\">One row per category with a live protocol: how many set the price, their median multiple, and the shrunk geometric multiple the model uses.</p>" +
        "<table><thead><tr><th>Category</th><th class=\"num\">Live</th><th class=\"num\">Median</th><th class=\"num\">Multiple</th></tr></thead><tbody>" +
        calibration
          .map(
            (c) =>
              "<tr><td>" + esc(c.category) + '</td><td class="num">' + c.n +
              '</td><td class="num">×' + c.median.toFixed(4) + '</td><td class="num">×' + c.multiple.toFixed(4) + "</td></tr>",
          )
          .join("") +
        "</tbody></table>" +
        "<h3 class=\"subhead\">Chain weights — share of live TVL</h3>" +
        "<p class=\"hint\">Chains are not counted, they are weighed: a chain's weight is its share of the live set's TVL. Ethereum alone carries 40% of it, so a protocol on Ethereum pays far more than one on five chains nobody's TVL sits on.</p>" +
        "<table><thead><tr><th>Chain</th><th class=\"num\">Live TVL share</th><th class=\"num\">Weight</th></tr></thead><tbody>" +
        weights
          .map(
            ([c, w]) =>
              "<tr><td>" + esc(c) + '</td><td class="num">' + (w * 100).toFixed(1) +
              '%</td><td class="num">' + w.toFixed(4) + "</td></tr>",
          )
          .join("") +
        "</tbody></table>";
      $("count").textContent = calibration.length + " categories · " + weights.length + " chains shown";
    }
  }

  // ---- detail dialog ------------------------------------------------------

  function splitStep(step) {
    const at = step.indexOf(" Cost: ");
    if (at < 0) return { main: step, cost: "" };
    return { main: step.slice(0, at + 1), cost: step.slice(at + 1) };
  }

  function openDetail(slug) {
    const row = rows.find((r) => r.slug === slug);
    if (!row) return;
    const c = recompute(row, sandbox);
    const entry = calibration.find((x) => x.category === row.category);
    const steps = farmSteps(row);
    const stake = farmStake(row.tvl_usd);
    const hold = holdDays(row.age_days);
    const gas = gasFor(row.farm_chain);
    const totalGas = farmCost(gas, hold);
    const dlg = $("detail");
    const why =
      row.on_watchlist
        ? "On the snapshot's watchlist: TVL at or above $50M, no token recorded, and not a wrapped or staked product."
        : "Below the watchlist floor, found early: the radar exists to find launches the watchlist misses.";
    const compNote =
      (row.change_7d === null || row.change_7d === undefined) ||
      (row.listed_at === null || row.listed_at === undefined)
        ? " The record is incomplete, so the value carries a haircut: 3% for an unreported seven-day change, 2% for an unreported listing date."
        : "";
    const bleedNote =
      c.bleed < 1
        ? "<dt>TVL bleed</dt><dd class=\"num\">" + pctText(row.change_7d) + " → ×" + c.bleed.toFixed(4) + " (below −20% in 7 days)</dd>"
        : "";
    dlg.innerHTML =
      '<div class="card"><button class="close" type="button">Close</button>' +
      '<div class="rankline">Rank ' + row.rank + " of " + rows.length + (row.on_watchlist ? " · Watchlist" : " · Early find") + "</div>" +
      "<h2>" + esc(row.name) + "</h2>" +
      '<p class="chains">' + esc(row.category) + " on " + esc(row.chains.join(", ")) + "</p>" +
      "<h3>Implied value — the waterfall</h3>" +
      '<dl class="eq">' +
      "<dt>TVL</dt><dd class=\"num\">" + money(row.tvl_usd) + "</dd>" +
      "<dt>Category multiple</dt><dd class=\"num\">×" + c.base.toFixed(4) + " (" + (entry ? entry.n : 0) + " live, median ×" + (entry ? entry.median.toFixed(4) : "—") + ")</dd>" +
      "<dt>Chain weight</dt><dd class=\"num\">×" + c.chain.toFixed(4) + " (" + row.chains.length + " chains, weight " + c.chain_weight.toFixed(3) + " of live TVL)</dd>" +
      "<dt>Category crowding</dt><dd class=\"num\">×" + c.crowding.toFixed(4) + " (" + c.crowding_n + " pre-token in this category)</dd>" +
      "<dt>Seven-day growth</dt><dd class=\"num\">" + pctText(row.change_7d) + " → ×" + c.growth.toFixed(4) + "</dd>" +
      bleedNote +
      "<dt>Age with no token</dt><dd class=\"num\">" + ageText(row.age_days) + " → ×" + c.maturity.toFixed(4) + " (log)</dd>" +
      "<dt>Completeness</dt><dd class=\"num\">×" + c.completeness.toFixed(4) + "</dd>" +
      '<dt class="total">Implied value</dt><dd class="total num">' + money(c.implied) + "</dd>" +
      "</dl>" +
      '<p class="why">' + why + compNote + "</p>" +
      "<p class=\"fine\">Model radar-4: the same function scores every protocol. The page recomputes this row as " +
      money(c.implied) + ", the same number board.json carries. This is an estimate, not a price.</p>" +
      "<h3>Farm plan — on " + esc(row.farm_chain) + " (cheapest gas)</h3><ol class=\"plan\">" +
      steps
        .map((s) => {
          const parts = splitStep(s);
          return "<li><div>" + esc(parts.main) + '</div><div class="cost">' + esc(parts.cost) + "</div></li>";
        })
        .join("") +
      "</ol>" +
      '<div class="plan-total">Farm total: <b>$' + stake + " of capital</b> in the position, <b>≈$" + totalGas +
      " of gas</b> across " + row.farm_weeks + " weeks on " + esc(row.farm_chain) + ", and <b>" + hold +
      " days</b> of holding. The capital comes back when you unwind; the gas does not.</div>" +
      "</div>";
    dlg.hidden = false;
    dlg.querySelector(".close").addEventListener("click", closeDetail);
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) closeDetail();
    });
  }

  function closeDetail() {
    $("detail").hidden = true;
    $("detail").innerHTML = "";
  }

  // ---- sandbox ------------------------------------------------------------

  const SANDBOX_FIELDS = [
    { key: "growth_weight", label: "Growth weight", min: 0, max: 1, step: 0.05 },
    { key: "maturity_floor", label: "Maturity floor", min: 0.3, max: 0.8, step: 0.05 },
    { key: "maturity_range", label: "Maturity range", min: 0.1, max: 0.6, step: 0.05 },
    { key: "shrink_prior", label: "Shrink prior", min: 0, max: 10, step: 1 },
    { key: "chain_weight_step", label: "Chain weight step", min: 0, max: 1.2, step: 0.05 },
    { key: "crowding_strength", label: "Crowding strength", min: 0, max: 0.15, step: 0.01 },
    { key: "bleed_strength", label: "Bleed strength", min: 0, max: 0.3, step: 0.05 },
    { key: "missing_data_factor", label: "Missing-data factor", min: 0.9, max: 1, step: 0.01 },
  ];

  function renderSandbox() {
    $("sandbox-grid").innerHTML = SANDBOX_FIELDS.map(
      (f) =>
        '<label>' + f.label +
        '<input type="range" data-key="' + f.key + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step +
        '" value="' + params[f.key] + '">' +
        '<output data-out="' + f.key + '">' + params[f.key] + "</output></label>",
    ).join("");
    document.querySelectorAll("#sandbox-grid input").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.getAttribute("data-key");
        document.querySelector('[data-out="' + key + '"]').textContent = input.value;
        const next = Object.assign({}, params);
        SANDBOX_FIELDS.forEach((f) => {
          next[f.key] = Number(document.querySelector('[data-key="' + f.key + '"]').value);
        });
        sandbox = SANDBOX_FIELDS.some((f) => next[f.key] !== params[f.key]) ? next : null;
        $("sandbox-state").textContent = sandbox ? "· Sandbox on" : "";
        renderBoard();
      });
    });
    $("sandbox-reset").addEventListener("click", () => {
      SANDBOX_FIELDS.forEach((f) => {
        const input = document.querySelector('[data-key="' + f.key + '"]');
        input.value = params[f.key];
        document.querySelector('[data-out="' + f.key + '"]').textContent = params[f.key];
      });
      sandbox = null;
      $("sandbox-state").textContent = "";
      renderBoard();
    });
  }

  // ---- wire up ------------------------------------------------------------

  function init() {
    renderMeta();
    renderHero();
    renderFacts();

    const cats = [...new Set(rows.map((r) => r.category))].sort();
    cats.forEach((c) => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      $("cat").appendChild(o);
    });
    const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
    chains.forEach((c) => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      $("chain").appendChild(o);
    });

    ["q", "cat", "chain", "min-tvl", "min-imp"].forEach((id) => {
      $(id).addEventListener("input", () => {
        renderBoard();
      });
    });
    $("watch-only").addEventListener("change", () => {
      renderBoard();
    });
    document.querySelectorAll("#board thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort");
        if (sortKey === key) {
          sortDir = -sortDir;
        } else {
          sortKey = key;
          sortDir = key === "rank" || key === "implied" || key === "tvl" || key === "mult" ? -1 : 1;
        }
        renderBoard();
      });
    });
    $("board-body").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-slug]");
      if (tr) openDetail(tr.getAttribute("data-slug"));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDetail();
    });

    const tabs = { board: $("view-board"), live: $("view-live"), cal: $("view-cal") };
    Object.keys(tabs).forEach((kind) => {
      tabs[kind].addEventListener("click", () => {
        Object.keys(tabs).forEach((k) => tabs[k].setAttribute("aria-selected", k === kind ? "true" : "false"));
        renderAlt(kind);
        if (kind === "board") renderBoard();
      });
    });

    renderSandbox();
    renderBoard();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
