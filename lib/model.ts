// Token radar value model: estimates implied pre-token value from live comparables.
// All scoring is formula-driven; no protocol slug or name gets special treatment.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface FarmPlan {
  steps: string[];
  gas_usd: number;
  capital_usd: number;
  capital_drag_usd: number;
  hours: number;
  hold_days: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  expected_airdrop_usd: number;
  ev_per_hour: number;
  verdict: 'farm' | 'thin' | 'skip';
  gas_usd: number;
  capital_drag_usd: number;
  farm_hours: number;
  growth_mult: number;
  age_mult: number;
  base_implied_usd: number;
}

export interface FitInfo {
  key: string;
  label: string;
  n: number;
  a: number;
  b: number;
  r2: number;
  dropped: number;
}

export interface ModelStats {
  n: number;
  r2: number;
  dropped: number;
  loo_mape_median: number;
  fits: FitInfo[];
  mode: 'category' | 'global';
  fallback_note: string | null;
}

export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  watchlist_total: number;
  watchlist_covered: number;
  board_rows: number;
  model: ModelStats & {
    formula: string;
    constants: string;
    allocation: number;
    verdict_rule: string;
    loo_sentence: string;
    ev_sentence: string;
  };
  implied_min: number;
  implied_max: number;
  median_ev_per_hour: number;
  comps: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number }[];
  rows: BoardRow[];
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function asNullableString(x: unknown, field: string): string | null {
  if (x === null) return null;
  if (typeof x === 'string') return x;
  throw new Error(`Invalid snapshot: ${field} must be string or null`);
}

function asNullableNumber(x: unknown, field: string): number | null {
  if (x === null) return null;
  if (isFiniteNumber(x)) return x;
  throw new Error(`Invalid snapshot: ${field} must be number or null`);
}

function parseProtocol(raw: unknown, i: number): Protocol {
  if (!raw || typeof raw !== 'object') throw new Error(`Invalid snapshot: protocol ${i} is not an object`);
  const p = raw as Record<string, unknown>;
  if (!isString(p.slug)) throw new Error(`Invalid snapshot: protocol ${i} slug missing`);
  if (!isString(p.name)) throw new Error(`Invalid snapshot: protocol ${i} name missing`);
  const category = asNullableString(p.category, `protocol ${i} category`);
  if (!Array.isArray(p.chains) || !p.chains.every(isString)) {
    throw new Error(`Invalid snapshot: protocol ${i} chains must be string array`);
  }
  if (!isFiniteNumber(p.tvl_usd)) throw new Error(`Invalid snapshot: protocol ${i} tvl_usd invalid`);
  const change_7d = asNullableNumber(p.change_7d, `protocol ${i} change_7d`);
  const mcap_usd = asNullableNumber(p.mcap_usd, `protocol ${i} mcap_usd`);
  const listed_at = asNullableString(p.listed_at, `protocol ${i} listed_at`);
  const gecko_id = asNullableString(p.gecko_id, `protocol ${i} gecko_id`);
  const symbol = asNullableString(p.symbol, `protocol ${i} symbol`);
  return {
    slug: p.slug,
    name: p.name,
    category,
    chains: p.chains as string[],
    tvl_usd: p.tvl_usd,
    change_7d,
    mcap_usd,
    listed_at,
    gecko_id,
    symbol,
  };
}

// Parse and validate the snapshot JSON text; throws a clear Error on bad input.
export function parseSnapshot(text: string): Snapshot {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid snapshot: not valid JSON');
  }
  if (!data || typeof data !== 'object') throw new Error('Invalid snapshot: root must be an object');
  const o = data as Record<string, unknown>;
  if (!isString(o.as_of)) throw new Error('Invalid snapshot: as_of missing');
  if (!isString(o.source)) throw new Error('Invalid snapshot: source missing');
  if (!isFiniteNumber(o.floor_usd)) throw new Error('Invalid snapshot: floor_usd missing');
  if (!Array.isArray(o.protocols)) throw new Error('Invalid snapshot: protocols must be an array');
  if (!Array.isArray(o.watchlist) || !o.watchlist.every(isString)) {
    throw new Error('Invalid snapshot: watchlist must be string array');
  }
  const protocols = o.protocols.map((p, i) => parseProtocol(p, i));
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

// A protocol is pre-token when it has no market cap, no gecko id, and no symbol recorded.
export function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// Whole days between as_of and listed_at (UTC day difference); null when listed_at is null.
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(asOf + 'T00:00:00Z');
  const l = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(l)) return null;
  const diff = Math.floor((a - l) / 86400000);
  return diff < 0 ? 0 : diff;
}

function hasVersionMarker(name: string): boolean {
  return /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/.test(name);
}

function isComparable(p: Protocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX' && !hasVersionMarker(p.name);
}

function isRankablePreToken(p: Protocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !hasVersionMarker(p.name);
}

interface Fit {
  a: number;
  b: number;
}

interface Point { tvl: number; mcap: number; }

// Ordinary least squares fit of log(mcap)=a+b*log(tvl). Returns null if fewer than 2 points.
function ols(points: Point[]): Fit | null {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const pt of points) {
    const x = Math.log(pt.tvl);
    const y = Math.log(pt.mcap);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

function predict(fit: Fit, tvl: number): number {
  return Math.exp(fit.a + fit.b * Math.log(Math.max(1, tvl)));
}

function r2For(points: Point[], fit: Fit): number {
  if (points.length < 2) return 0;
  let sy = 0;
  for (const pt of points) sy += Math.log(pt.mcap);
  const meanY = sy / points.length;
  let ssTot = 0, ssRes = 0;
  for (const pt of points) {
    const y = Math.log(pt.mcap);
    const yhat = fit.a + fit.b * Math.log(pt.tvl);
    const dy = y - meanY;
    const dr = y - yhat;
    ssTot += dy * dy;
    ssRes += dr * dr;
  }
  return ssTot <= 0 ? 1 : 1 - ssRes / ssTot;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function roundTo(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// Robust fit: 3x median absolute residual screen, drop and refit once.
function robustFit(points: Point[]): { fit: Fit; kept: Point[]; dropped: number } {
  const fit1 = ols(points);
  if (!fit1 || points.length < 3) {
    const f = fit1 || { a: 0, b: 0 };
    return { fit: f, kept: points, dropped: 0 };
  }
  const absRes = points.map((pt) => Math.abs(Math.log(pt.mcap) - (fit1.a + fit1.b * Math.log(pt.tvl))));
  const mad = median(absRes);
  if (mad <= 0) return { fit: fit1, kept: points, dropped: 0 };
  const threshold = mad * 3;
  const filtered = points.filter((pt) => Math.abs(Math.log(pt.mcap) - (fit1.a + fit1.b * Math.log(pt.tvl))) <= threshold);
  const kept = filtered.length >= 2 ? filtered : points;
  const fit2 = ols(kept) || fit1;
  return { fit: fit2, kept, dropped: points.length - kept.length };
}

function looForPoints(points: Point[]): number {
  const apes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const train = points.filter((_, j) => j !== i);
    if (train.length < 2) continue;
    const { fit } = robustFit(train);
    const pred = predict(fit, points[i].tvl);
    const actual = points[i].mcap;
    if (actual > 0) apes.push(Math.abs(pred - actual) / actual);
  }
  return apes.length ? median(apes) : 0;
}

interface CompPoint extends Point { slug: string; category: string | null; }
interface GroupFit { key: string; label: string; comps: CompPoint[]; fit: Fit; kept: Point[]; dropped: number; }

interface ValueModel {
  mode: 'category' | 'global';
  predictBase(tvl: number, category: string | null): number;
  stats: ModelStats;
}

function buildGroups(comps: CompPoint[]): GroupFit[] {
  const byCat = new Map<string, CompPoint[]>();
  for (const c of comps) {
    const key = c.category === null ? '__null__' : c.category;
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(c);
  }
  const bigKeys = new Set<string>();
  for (const [key, arr] of byCat) if (arr.length >= 12) bigKeys.add(key);
  const groups: GroupFit[] = [];
  const pooled: CompPoint[] = [];
  for (const [key, arr] of byCat) {
    if (bigKeys.has(key)) {
      const { fit, kept, dropped } = robustFit(arr);
      const label = key === '__null__' ? 'Unknown' : key;
      groups.push({ key, label, comps: arr, fit, kept, dropped });
    } else {
      pooled.push(...arr);
    }
  }
  if (pooled.length >= 2) {
    const { fit, kept, dropped } = robustFit(pooled);
    groups.push({ key: '__pooled__', label: 'Pooled (small categories)', comps: pooled, fit, kept, dropped });
  }
  return groups;
}

function groupForCategory(category: string | null, groups: GroupFit[]): GroupFit | null {
  const key = category === null ? '__null__' : category;
  const direct = groups.find((g) => g.key === key);
  if (direct) return direct;
  return groups.find((g) => g.key === '__pooled__') || groups[0] || null;
}

function overallR2ForGroups(groups: GroupFit[]): number {
  const all: { y: number; yhat: number }[] = [];
  for (const g of groups) {
    for (const c of g.comps) all.push({ y: Math.log(c.mcap), yhat: g.fit.a + g.fit.b * Math.log(c.tvl) });
  }
  if (all.length < 2) return 0;
  let sy = 0;
  for (const p of all) sy += p.y;
  const meanY = sy / all.length;
  let ssTot = 0, ssRes = 0;
  for (const p of all) { const dy = p.y - meanY; const dr = p.y - p.yhat; ssTot += dy * dy; ssRes += dr * dr; }
  return ssTot <= 0 ? 1 : 1 - ssRes / ssTot;
}

function overallLooForGroups(groups: GroupFit[]): number {
  const apes: number[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.comps.length; i++) {
      const train = g.comps.filter((_, j) => j !== i);
      if (train.length < 2) continue;
      const { fit } = robustFit(train);
      const pred = predict(fit, g.comps[i].tvl);
      const actual = g.comps[i].mcap;
      if (actual > 0) apes.push(Math.abs(pred - actual) / actual);
    }
  }
  return apes.length ? median(apes) : 0;
}

function fitInfos(groups: GroupFit[]): FitInfo[] {
  return groups.map((g) => ({
    key: g.key,
    label: g.label,
    n: g.kept.length,
    a: g.fit.a,
    b: roundTo(g.fit.b, 6),
    r2: roundTo(r2For(g.kept, g.fit), 6),
    dropped: g.dropped,
  }));
}

function buildGlobalModel(comps: CompPoint[]): ValueModel {
  const { fit, kept, dropped } = robustFit(comps);
  const r2 = r2For(kept, fit);
  const loo = looForPoints(comps);
  const info: FitInfo = { key: '__global__', label: 'Global', n: kept.length, a: fit.a, b: roundTo(fit.b, 6), r2: roundTo(r2, 6), dropped };
  return {
    mode: 'global',
    predictBase: (tvl) => predict(fit, tvl),
    stats: { n: kept.length, r2: roundTo(r2, 6), dropped, loo_mape_median: roundTo(loo, 6), fits: [info], mode: 'global', fallback_note: null },
  };
}

function buildCategoryModel(comps: CompPoint[]): ValueModel | null {
  const groups = buildGroups(comps);
  if (groups.length === 0) return null;
  const hasCategoryFit = groups.some((g) => g.key !== '__pooled__');
  if (!hasCategoryFit) return null; // no category had >=12, equivalent to global
  const r2 = overallR2ForGroups(groups);
  const loo = overallLooForGroups(groups);
  const totalKept = groups.reduce((s, g) => s + g.kept.length, 0);
  const totalDropped = groups.reduce((s, g) => s + g.dropped, 0);
  return {
    mode: 'category',
    predictBase: (tvl, category) => {
      const g = groupForCategory(category, groups);
      if (!g) return predict(groups[0].fit, tvl);
      return predict(g.fit, tvl);
    },
    stats: { n: totalKept, r2: roundTo(r2, 6), dropped: totalDropped, loo_mape_median: roundTo(loo, 6), fits: fitInfos(groups), mode: 'category', fallback_note: null },
  };
}

function chooseModel(comps: CompPoint[]): ValueModel {
  const globalM = buildGlobalModel(comps);
  const catM = buildCategoryModel(comps);
  if (!catM) return globalM;
  const catWorse = catM.stats.r2 < globalM.stats.r2 || catM.stats.loo_mape_median > globalM.stats.loo_mape_median;
  if (catWorse) {
    globalM.stats.fallback_note = `Category fits had r2 ${fmtPct(catM.stats.r2,4)} / LOO ${fmtPct(catM.stats.loo_mape_median*100,2)}% vs global r2 ${fmtPct(globalM.stats.r2,4)} / LOO ${fmtPct(globalM.stats.loo_mape_median*100,2)}%; using the better global fit.`;
    return globalM;
  }
  return catM;
}

function fmtPct(n: number, d: number): string {
  return n.toFixed(d);
}

function pickCategoryKeyword(category: string | null): string {
  const c = (category || '').toLowerCase();
  if (c.includes('lend') || c.includes('credit') || c.includes('cdp')) return 'lending';
  if (c.includes('dex') || c.includes('swap') || c.includes('amm')) return 'dex';
  if (c.includes('bridge') || c.includes('cross chain')) return 'bridge';
  if (c.includes('staking') || c.includes('restak')) return 'staking';
  if (c.includes('perp') || c.includes('derivative')) return 'perps';
  if (c.includes('vault') || c.includes('yield') || c.includes('farm') || c.includes('basis') || c.includes('liquidity manager')) return 'vaults';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  if (c.includes('stable')) return 'stablecoin';
  if (c.includes('insurance') || c.includes('cover')) return 'insurance';
  return 'general';
}

function tvlTier(tvl: number): { capital: number; label: string } {
  if (tvl >= 150_000_000) return { capital: 250, label: 'large' };
  if (tvl >= 80_000_000) return { capital: 150, label: 'mid-large' };
  if (tvl >= 30_000_000) return { capital: 100, label: 'mid' };
  return { capital: 50, label: 'early' };
}

function holdWindow(age: number | null): number {
  const a = age === null ? 365 : age;
  if (a >= 365) return 30;
  if (a >= 180) return 45;
  return 60;
}

function qualifyingAction(keyword: string, capital: number): { text: string; cost: number; hours: number } {
  switch (keyword) {
    case 'lending':
      return { text: `Supply about $${capital} as collateral and borrow a small amount, keeping health factor safe to register lending usage`, cost: 3, hours: 1.0 };
    case 'dex':
      return { text: `Swap and provide about $${capital} in liquidity on a main pool to record DEX volume and LP activity`, cost: 4, hours: 1.0 };
    case 'bridge':
      return { text: `Bridge about $${capital} through the protocol route and back if needed to register cross-chain transfer activity`, cost: 6, hours: 1.0 };
    case 'staking':
      return { text: `Stake about $${capital} (or the minimum accepted amount) through the protocol to register staking participation`, cost: 2, hours: 0.75 };
    case 'perps':
      return { text: `Deposit about $${capital} as margin and place a small hedged perpetual position to register trading activity`, cost: 5, hours: 1.25 };
    case 'vaults':
      return { text: `Deposit about $${capital} into a core yield vault or strategy to register on-chain capital allocation activity`, cost: 3, hours: 0.75 };
    case 'rwa':
      return { text: `Complete onboarding steps if available and allocate about $${capital} to a supported RWA or yield product`, cost: 3, hours: 1.25 };
    case 'stablecoin':
      return { text: `Mint, hold, or provide about $${capital} of the protocol stablecoin/liquidity to register core product usage`, cost: 3, hours: 0.75 };
    case 'insurance':
      return { text: `Provide about $${capital} of cover or underwriting capacity where open to register insurance protocol usage`, cost: 3, hours: 1.0 };
    default:
      return { text: `Use the protocol's primary on-chain action with about $${capital} to register meaningful usage`, cost: 3, hours: 1.0 };
  }
}

function buildFarmPlan(p: Protocol, age: number | null): FarmPlan {
  const keyword = pickCategoryKeyword(p.category);
  const tier = tvlTier(p.tvl_usd);
  const hold = holdWindow(age);
  const capital = tier.capital;
  const qa = qualifyingAction(keyword, capital);
  const weeklyHours = 0.25;
  const weeklyCost = 1;
  const weeks = Math.max(2, Math.ceil(hold / 7));
  const weeklyTotalHours = roundTo(weeklyHours * weeks, 2);
  const weeklyTotalCost = weeklyCost * weeks;
  const capitalDrag = roundTo(capital * 0.05 * (hold / 365), 2);
  const hygieneCost = 2;
  const hygieneHours = 0.5;
  const exitCost = 2;
  const exitHours = 0.5;
  const checkCost = 0;
  const checkHours = 0.25;
  const logCost = 0;
  const logHours = 0.25;

  const steps = [
    `Fresh wallet hygiene: fund a dedicated wallet and bridge or swap working capital of about $${capital}; cost $${hygieneCost} in fees, duration ${hygieneHours}h.`,
    `Qualifying ${keyword} action: ${qa.text}; cost $${qa.cost} in fees, duration ${qa.hours}h.`,
    `Weekly activity: repeat a small on-chain interaction each week for ${weeks} weeks to keep usage consistent; total cost $${weeklyTotalCost}, total duration ${weeklyTotalHours}h.`,
    `Hold window: keep the qualifying position or balance active for ${hold} days to build account age and sustained usage; ongoing monitoring time included above.`,
    `Points and rewards check: review the protocol's points, quests, or rewards page each week and confirm transactions recorded; cost $${checkCost}, duration ${checkHours}h.`,
    `Exit and unwind: close positions, withdraw funds, and reconcile balances at the end of the window; cost $${exitCost} in fees, duration ${exitHours}h.`,
    `Farm log: record wallet, tx hashes, dates, costs, and outcomes in a simple log for future claims; cost $${logCost}, duration ${logHours}h.`,
  ];

  const gas = hygieneCost + qa.cost + weeklyTotalCost + exitCost;
  const hours = roundTo(hygieneHours + qa.hours + weeklyTotalHours + checkHours + exitHours + logHours, 2);

  return { steps, gas_usd: gas, capital_usd: capital, capital_drag_usd: capitalDrag, hours, hold_days: hold };
}

function impliedValue(p: Protocol, asOf: string, baseRaw: number): { implied: number; base: number; growthMult: number; ageMult: number; age: number | null } {
  const growth = clamp(p.change_7d === null ? 0 : p.change_7d, -40, 80);
  const growthMult = 1 + (growth / 100) * 0.6;
  const age = ageDays(asOf, p.listed_at);
  const ageForMult = age === null ? 365 : age;
  const ageMult = 0.7 + Math.min(ageForMult, 1095) / 1095 * 0.3;
  const implied = Math.max(1, Math.min(1e14, Math.round(baseRaw * growthMult * ageMult)));
  return { implied, base: baseRaw, growthMult: roundTo(growthMult, 6), ageMult: roundTo(ageMult, 6), age };
}

function verdictFor(evPerHour: number, medianEv: number): 'farm' | 'thin' | 'skip' {
  if (evPerHour >= medianEv) return 'farm';
  if (evPerHour >= medianEv / 3) return 'thin';
  return 'skip';
}

function buildBoardWithModel(snapshot: Snapshot, model: ValueModel): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));

  const selected = new Set<string>();
  const addSlug = (slug: string) => { if (bySlug.has(slug)) selected.add(slug); };
  for (const slug of snapshot.watchlist) addSlug(slug);

  const belowFloor = snapshot.protocols
    .filter((p) => isRankablePreToken(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
  for (const p of belowFloor.slice(0, 160)) selected.add(p.slug);

  const candidates: Omit<BoardRow, 'rank' | 'verdict' | 'ev_per_hour'>[] = [];
  for (const slug of selected) {
    const p = bySlug.get(slug);
    if (!p) continue;
    const baseRaw = model.predictBase(p.tvl_usd, p.category);
    const iv = impliedValue(p, snapshot.as_of, baseRaw);
    const plan = buildFarmPlan(p, iv.age);
    const expected = iv.implied * 0.005;
    candidates.push({
      slug: p.slug,
      name: p.name,
      implied_value_usd: iv.implied,
      farm_steps: plan.steps,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: iv.age,
      expected_airdrop_usd: roundTo(expected, 2),
      gas_usd: plan.gas_usd,
      capital_drag_usd: plan.capital_drag_usd,
      farm_hours: plan.hours,
      growth_mult: iv.growthMult,
      age_mult: iv.ageMult,
      base_implied_usd: Math.round(iv.base),
    } as any);
  }

  candidates.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  const evList = candidates.map((c) => (c.expected_airdrop_usd - c.gas_usd - c.capital_drag_usd) / Math.max(0.01, c.farm_hours));
  const medEv = median(evList);

  let rows: BoardRow[] = candidates.map((c, idx) => {
    const ev = (c.expected_airdrop_usd - c.gas_usd - c.capital_drag_usd) / Math.max(0.01, c.farm_hours);
    return {
      ...(c as any),
      rank: idx + 1,
      ev_per_hour: roundTo(ev, 4),
      verdict: verdictFor(ev, medEv),
    };
  });

  // Ensure implied never rises as rank ascends (rank 1 is highest).
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) {
      rows[i].implied_value_usd = rows[i - 1].implied_value_usd;
    }
  }
  // Recompute expected airdrop and EV if implied was adjusted to keep values consistent.
  for (const r of rows) {
    r.expected_airdrop_usd = roundTo(r.implied_value_usd * 0.005, 2);
    r.ev_per_hour = roundTo((r.expected_airdrop_usd - r.gas_usd - r.capital_drag_usd) / Math.max(0.01, r.farm_hours), 4);
  }
  const finalMed = median(rows.map((r) => r.ev_per_hour));
  for (const r of rows) r.verdict = verdictFor(r.ev_per_hour, finalMed);
  return rows;
}

// Build the ranked board: watchlist first requirement plus top 160 rankable pre-token below floor.
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const comps: CompPoint[] = snapshot.protocols.filter(isComparable).map((p) => ({ tvl: p.tvl_usd, mcap: p.mcap_usd as number, slug: p.slug, category: p.category }));
  const model = chooseModel(comps);
  return buildBoardWithModel(snapshot, model);
}

// Validate a board against the required rules; return issue string or null if valid.
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (!Array.isArray(board) || board.length < 1) return 'board must be a non-empty array';
  const ranks = board.map((r) => r.rank);
  for (let i = 0; i < board.length; i++) {
    if (board[i].rank !== i + 1) return `rank gap or mismatch at index ${i}: expected ${i + 1} got ${board[i].rank}`;
  }
  const seenRanks = new Set(ranks);
  if (seenRanks.size !== board.length) return 'duplicate ranks found';
  for (let i = 1; i < board.length; i++) {
    if (board[i].implied_value_usd > board[i - 1].implied_value_usd) {
      return `implied value rises at rank ${board[i].rank}`;
    }
  }
  const slugs = new Set(board.map((r) => r.slug));
  for (const w of snapshot.watchlist) {
    if (!slugs.has(w)) return `watchlist slug missing from board: ${w}`;
  }
  for (const r of board) {
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `row ${r.slug} has non-positive whole implied_value_usd`;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${r.slug} has invalid farm_steps count`;
    }
    for (const step of r.farm_steps) {
      const t = step.trim();
      if (t.length < 20 || t.length > 600) return `row ${r.slug} has farm step length ${t.length}`;
    }
  }
  return null;
}

// Build the full radar payload for the dashboard, including the ranked board.
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarPayload } {
  const comps: CompPoint[] = snapshot.protocols.filter(isComparable).map((p) => ({ tvl: p.tvl_usd, mcap: p.mcap_usd as number, slug: p.slug, category: p.category }));
  const model = chooseModel(comps);
  const board = buildBoardWithModel(snapshot, model);
  const evs = board.map((r) => r.ev_per_hour);
  const medEv = median(evs);
  for (const r of board) {
    r.verdict = verdictFor(r.ev_per_hour, medEv);
  }
  const impliedVals = board.map((r) => r.implied_value_usd);
  const implied_min = Math.min(...impliedVals);
  const implied_max = Math.max(...impliedVals);
  const watchCovered = snapshot.watchlist.filter((s) => board.some((r) => r.slug === s)).length;
  const looPct = roundTo(model.stats.loo_mape_median * 100, 2);
  const modeText = model.mode === 'category'
    ? 'per-category fits for categories with at least 12 live-token comparables, with smaller categories pooled'
    : 'a single global fit on live-token comparables';
  const formula = `log(mcap)=a+b·log(tvl) fitted by OLS using ${modeText}; implied = round(exp(a+b·log(tvl)) · growthMult · ageMult), capped at 1e14`;
  const constants = 'growth = clamp(change_7d, -40, 80); growthMult = 1 + (growth/100)*0.6; ageMult = 0.7 + min(age_days,1095)/1095*0.3 (365 days if unknown); capital drag = capital*5%*(hold_days/365)';
  const ev_sentence = 'EV per active hour is the expected airdrop minus gas and capital drag, divided by the plan\'s estimated active hours; the airdrop itself is a stated 0.50% assumption, not a forecast.';
  const verdict_rule = `Verdict: farm if EV per active hour >= board median ($${roundTo(medEv, 2)}/hr), thin if >= one third of median, else skip.`;
  const loo_sentence = `Leave-one-out test (refit without each comparable and predict it using its category or pooled fit): median absolute percentage error ${looPct}% across ${comps.length} comps.`;
  const radar: RadarPayload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    watchlist_total: snapshot.watchlist.length,
    watchlist_covered: watchCovered,
    board_rows: board.length,
    model: {
      ...model.stats,
      formula,
      constants,
      allocation: 0.005,
      verdict_rule,
      loo_sentence,
      ev_sentence,
    },
    implied_min,
    implied_max,
    median_ev_per_hour: roundTo(medEv, 4),
    comps: comps.map((p) => ({ slug: p.slug, name: snapshot.protocols.find(pp=>pp.slug===p.slug)?.name || p.slug, category: p.category, tvl_usd: p.tvl, mcap_usd: p.mcap })),
    rows: board,
  };
  return { board, radar };
}

// Serialize the radar payload as a script that sets window.RADAR.
export function dataScript(radar: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
