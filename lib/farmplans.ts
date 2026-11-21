// Farm plans: a deterministic layer that turns one radar row into a short, ranked to-do list.
// The rules stay local to the row: age and 7d change shape the launch window, chain count, TVL
// band and momentum shape the effort tier, and the tier plus the board economics order the steps.
// No clock, no network and no input mutation: equal inputs always produce an equal plan.

import type { BoardRow, Snapshot } from './model.ts';

export type EffortTier = 'low' | 'medium' | 'high';
export type WindowBand = 'imminent' | 'near' | 'medium' | 'distant';
export type PlanConfidence = 'low' | 'medium' | 'high';
export type ActionKind = 'deposit' | 'interact' | 'reserve' | 'monitor' | 'exit';

export interface FarmAction {
  priority: number;
  kind: ActionKind;
  target: string;
  detail: string;
  size_usd: number;
  watch_for: string;
}

export interface FarmPlanDetail {
  slug: string;
  name: string;
  board_rank: number;
  verdict: BoardRow['verdict'];
  days_to_window: number;
  window_band: WindowBand;
  confidence: PlanConfidence;
  effort: EffortTier;
  effort_score: number;
  effort_reasons: string[];
  actions: FarmAction[];
  rationale: string;
  effort_adjusted_score: number;
  suggested_capital_usd: number;
  data_flags: string[];
}

export interface TierCounts {
  low: number;
  medium: number;
  high: number;
}

export interface WindowCounts {
  imminent: number;
  near: number;
  medium: number;
  distant: number;
}

export interface FlagCounts {
  missing_change: number;
  zero_chains: number;
  missing_age: number;
}

export interface TopPick {
  slug: string;
  name: string;
  score: number;
  effort: EffortTier;
  days_to_window: number;
  board_rank: number;
}

export interface FarmPlanSummary {
  total: number;
  tiers: TierCounts;
  windows: WindowCounts;
  flags: FlagCounts;
  average_days_to_window: number;
  median_score: number;
  suggested_capital_usd: number;
  top_picks: TopPick[];
}

// Age anchors in days; the matching numbers are median waiting times to a launch decision.
// Interpolating between anchors avoids a jump when a protocol crosses a whole-year boundary.
const DAY_ANCHORS: readonly number[] = [0, 90, 180, 365, 730, 1460];
const DAY_EXPECTATIONS: readonly number[] = [330, 255, 185, 125, 80, 45];
const MS_PER_DAY = 86_400_000;

// Effort is a weighted sum of three 0..3 signals. A multi-chain, large, fast-growing protocol
// needs more distinct transactions and more monitoring than a quiet single-chain nano app.
// Revision 2: momentum now matches TVL size, so a hot tiny app is not mistaken for low effort.
const CHAIN_WEIGHT = 0.4;
const BAND_WEIGHT = 0.3;
const MOMENTUM_WEIGHT = 0.3;

interface TvlBand {
  label: string;
  points: number;
  capital: number;
}

// TVL bands are deliberately coarse: the snapshot is a point in time, so fine tiers imply
// a precision the data does not have. Capital is a suggested test budget, not a recommendation.
const TVL_BANDS: readonly TvlBand[] = [
  { label: 'nano', points: 0, capital: 60 },
  { label: 'small', points: 1, capital: 120 },
  { label: 'mid', points: 2, capital: 220 },
  { label: 'large', points: 3, capital: 400 },
];

interface DepositRecipe {
  verb: string;
  noun: string;
  watch: string;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function round(value: number, digits: number): number {
  const scale = Math.pow(10, digits);
  return Math.round(value * scale) / scale;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// UTC day difference keeps the window estimate independent of the machine's local timezone.
function daysBetween(asOf: string, listedAt: string | null): number | null {
  if (typeof listedAt !== 'string' || listedAt === '') return null;
  const end = Date.parse(asOf + 'T00:00:00Z');
  const start = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  const days = Math.floor((end - start) / MS_PER_DAY);
  return days < 0 ? 0 : days;
}

// Prefer the board's age (already sanitized by the model) and fall back to the raw listed_at.
function resolveAge(asOf: string, row: BoardRow, listedAt: string | null): number | null {
  if (typeof row.age_days === 'number' && Number.isFinite(row.age_days)) {
    return Math.max(0, Math.floor(row.age_days));
  }
  return daysBetween(asOf, listedAt);
}

function interpolateDays(age: number): number {
  const a = clamp(age, DAY_ANCHORS[0]!, DAY_ANCHORS[DAY_ANCHORS.length - 1]!);
  for (let i = 1; i < DAY_ANCHORS.length; i++) {
    const hi = DAY_ANCHORS[i]!;
    if (a <= hi) {
      const lo = DAY_ANCHORS[i - 1]!;
      const portion = (a - lo) / (hi - lo);
      return DAY_EXPECTATIONS[i - 1]! + portion * (DAY_EXPECTATIONS[i]! - DAY_EXPECTATIONS[i - 1]!);
    }
  }
  return DAY_EXPECTATIONS[DAY_EXPECTATIONS.length - 1]!;
}

function tvlBand(tvl: number): TvlBand {
  if (!Number.isFinite(tvl) || tvl <= 0) return TVL_BANDS[0]!;
  if (tvl < 10_000_000) return TVL_BANDS[0]!;
  if (tvl < 50_000_000) return TVL_BANDS[1]!;
  if (tvl < 200_000_000) return TVL_BANDS[2]!;
  return TVL_BANDS[3]!;
}

// Chain count is a deployment footprint, not a quality score: missing chains earn zero points
// because there is no evidence of a multi-chain routine to plan for.
function chainPoints(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  return 3;
}

// Rising TVL shortens the expected wait; a drawdown lengthens it. A missing reading is neutral
// rather than optimistic, so a data gap can never manufacture a "launch is close" claim.
function momentumPoints(change: number | null): number {
  if (change === null || !Number.isFinite(change)) return 1;
  if (change <= -20) return 0;
  if (change < 8) return 1;
  if (change < 35) return 2;
  return 3;
}

// Revision 2 guard: null, undefined and non-finite readings all become a flagged missing value.
// Without this, NaN could pass through the math and quietly poison the whole plan summary.
function readChange(row: BoardRow, flags: string[]): number | null {
  const raw = row.change_7d;
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    flags.push('missing_change');
    return null;
  }
  return raw;
}

function tierFor(score: number): EffortTier {
  if (score < 1.15) return 'low';
  if (score < 2.05) return 'medium';
  return 'high';
}

function windowBandFor(days: number): WindowBand {
  if (days <= 75) return 'imminent';
  if (days <= 180) return 'near';
  if (days <= 330) return 'medium';
  return 'distant';
}

function confidenceFor(age: number | null, change: number | null): PlanConfidence {
  if (age !== null && change !== null) return 'high';
  if (age !== null || change !== null) return 'medium';
  return 'low';
}

interface WindowEstimate {
  days: number;
  band: WindowBand;
  confidence: PlanConfidence;
}

function estimateWindow(age: number | null, change: number | null, tvl: TvlBand): WindowEstimate {
  const base = interpolateDays(age === null ? 365 : age);
  const growth = change === null ? 0 : clamp(change, -60, 120);
  const momentumFactor = 1 - (growth / 100) * 0.35;
  // Larger protocols historically need a longer runway; tiny ones can ship on a shorter notice.
  const sizeFactor = tvl.points === 0 ? 0.92 : tvl.points === 1 ? 0.97 : tvl.points === 2 ? 1.05 : 1.12;
  const days = Math.round(clamp(base * momentumFactor * sizeFactor, 20, 540));
  return { days, band: windowBandFor(days), confidence: confidenceFor(age, change) };
}

// Map a free-form DefiLlama category to a concrete on-chain action. Unknown categories get a
// generic primary action rather than being dropped from the board.
function categoryKey(category: string | null): string {
  const text = (category || '').toLowerCase();
  if (text.includes('lend') || text.includes('credit') || text.includes('cdp')) return 'lending';
  if (text.includes('swap') || text.includes('dex') || text.includes('amm')) return 'spot';
  if (text.includes('bridge') || text.includes('cross chain')) return 'bridge';
  if (text.includes('stake') || text.includes('restake')) return 'staking';
  if (text.includes('perp') || text.includes('derivative')) return 'perps';
  if (text.includes('vault') || text.includes('yield') || text.includes('farm')) return 'vault';
  if (text.includes('rwa') || text.includes('real world')) return 'rwa';
  if (text.includes('stable')) return 'stable';
  if (text.includes('insurance') || text.includes('cover')) return 'insurance';
  return 'general';
}

function recipeFor(key: string): DepositRecipe {
  switch (key) {
    case 'lending':
      return { verb: 'supply', noun: 'a small collateral balance in a core lending market', watch: 'borrow utilization and health factor' };
    case 'spot':
      return { verb: 'provide', noun: 'a modest liquidity position in the main swap pool', watch: 'pool volume and fee share' };
    case 'bridge':
      return { verb: 'route', noun: 'a small transfer through the protocol bridge', watch: 'route uptime and bridge fees' };
    case 'staking':
      return { verb: 'stake', noun: 'the minimum accepted amount with a liquid validator', watch: 'validator set and unstaking delay' };
    case 'perps':
      return { verb: 'post', noun: 'a small margin balance for a hedged perpetual trade', watch: 'funding rate and liquidation price' };
    case 'vault':
      return { verb: 'deposit', noun: 'a test amount in the primary yield vault', watch: 'vault APY and withdrawal queue' };
    case 'rwa':
      return { verb: 'allocate', noun: 'the smallest allowed ticket in a live RWA product', watch: 'onboarding checks and redemption terms' };
    case 'stable':
      return { verb: 'mint', noun: 'a small amount of the protocol stablecoin', watch: 'peg deviation and redemption depth' };
    case 'insurance':
      return { verb: 'provide', noun: 'a small amount of cover capacity', watch: 'claim history and cover utilization' };
    default:
      return { verb: 'use', noun: 'the protocol primary on-chain action', watch: 'transaction confirmation and points eligibility' };
  }
}

// Capital scales with the TVL band, then tilts up for a close window or a busy multi-chain plan.
function capitalFor(band: TvlBand, effort: EffortTier, days: number): number {
  const urgency = days <= 100 ? 1.1 : days <= 220 ? 1 : 0.9;
  const busy = effort === 'high' ? 1.15 : effort === 'medium' ? 1.05 : 1;
  return Math.round((band.capital * urgency * busy) / 10) * 10;
}

function effortReasons(chains: number, band: TvlBand, change: number | null): string[] {
  const reasons: string[] = [
    `${chains} chain(s) give ${chainPoints(chains)} footprint points`,
    `${band.label} TVL band gives ${band.points} size points`,
  ];
  if (change === null) reasons.push('no 7d change recorded, so momentum is neutral');
  else reasons.push(`7d change ${change.toFixed(1)}% gives ${momentumPoints(change)} momentum points`);
  return reasons;
}

// Fill every action first, then order by the launch window: a close window front-loads capital,
// a distant one front-loads verification so the reader does not fund a stale data point.
function orderActions(actions: FarmAction[], closeWindow: boolean): FarmAction[] {
  const first: ActionKind[] = closeWindow
    ? ['deposit', 'interact', 'reserve', 'monitor', 'exit']
    : ['monitor', 'reserve', 'deposit', 'interact', 'exit'];
  const byKind = new Map<ActionKind, FarmAction>();
  for (const action of actions) byKind.set(action.kind, action);
  const ordered: FarmAction[] = [];
  for (const kind of first) {
    const action = byKind.get(kind);
    if (!action) continue;
    action.priority = ordered.length + 1;
    ordered.push(action);
  }
  return ordered;
}

function buildActions(
  chains: string[],
  key: string,
  recipe: DepositRecipe,
  band: TvlBand,
  days: number,
  capital: number,
  effort: EffortTier,
): FarmAction[] {
  // Revision 2 guard: with no chains reported, never point the reader at a made-up network.
  const hasChains = chains.length > 0;
  const primaryChain = hasChains ? chains[0]! : 'chain not reported';
  const otherChain = chains[1] || primaryChain;
  const gasReserve = 12 + chains.length * 6 + (effort === 'high' ? 8 : 0);
  const actions: FarmAction[] = [
    {
      priority: 0,
      kind: 'deposit',
      target: hasChains ? `${recipe.noun} on ${primaryChain}` : `${recipe.noun} after chain verification`,
      detail: hasChains
        ? `Deposit about $${capital} (${band.label} TVL sizing) into ${recipe.noun} on ${primaryChain}; keep the position active through the ${days}-day review window.`
        : `Hold the $${capital} test budget until the deployment chain is confirmed, then ${recipe.verb} ${recipe.noun} on that network.`,
      size_usd: capital,
      watch_for: recipe.watch,
    },
    {
      priority: 0,
      kind: 'interact',
      target: hasChains ? `follow-up action on ${otherChain}` : 'single-network repeat action',
      detail: hasChains
        ? `Make one small follow-up transaction on ${otherChain} after the first deposit so the wallet shows more than a single event.`
        : `Do not plan a second-chain hop yet; repeat the same ${recipe.verb} action on the confirmed network instead.`,
      size_usd: Math.round(capital * 0.15),
      watch_for: 'transaction confirmation and repeated-usage credit',
    },
    {
      priority: 0,
      kind: 'reserve',
      target: `gas reserve on ${primaryChain}`,
      detail: `Keep about $${gasReserve} for fees across ${chains.length || 1} chain(s) before funding the main position.`,
      size_usd: gasReserve,
      watch_for: 'native token balance and fee spikes',
    },
    {
      priority: 0,
      kind: 'monitor',
      target: `${key} dashboard and TVL trend`,
      detail: `Review the points page and weekly TVL direction; if TVL keeps falling, delay the larger deposit until the trend stabilizes.`,
      size_usd: 0,
      watch_for: hasChains
        ? 'points announcements, TVL direction, and the next snapshot change_7d'
        : 'chain list, points announcements, and the next snapshot change_7d',
    },
    {
      priority: 0,
      kind: 'exit',
      target: 'end-of-window unwind',
      detail: `After ${days} days, unwind the position unless a launch notice or points snapshot is announced; log tx hashes and realized cost.`,
      size_usd: 0,
      watch_for: 'a launch notice or a new points round',
    },
  ];
  return orderActions(actions, days <= 120);
}

// Effort and launch proximity discount the raw EV: the same $/hour is less attractive when it
// needs many chains or when the expected launch is far outside the planning horizon.
function effortFactor(tier: EffortTier): number {
  if (tier === 'low') return 1;
  if (tier === 'medium') return 0.82;
  return 0.62;
}

function adjustedScore(
  row: BoardRow,
  days: number,
  change: number | null,
  tier: EffortTier,
): number {
  const hourly = Math.max(0, finiteOr(row.ev_per_hour, 0));
  const proximity = 1 - clamp(days, 0, 540) / 540;
  const launchBonus = proximity * 18;
  const growthBonus = change === null ? 0 : (clamp(change, 0, 60) / 60) * 6;
  return round((hourly + launchBonus + growthBonus) * effortFactor(tier), 4);
}

function rationaleFor(
  row: BoardRow,
  age: number | null,
  change: number | null,
  chains: string[],
  band: TvlBand,
  days: number,
  tier: EffortTier,
  lead: FarmAction,
): string {
  const ageText = age === null ? 'unknown age' : `${age}d old`;
  const changeText = change === null ? 'no 7d change' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% 7d`;
  const chainText = chains.length === 0 ? 'no chain reported' : `${chains.length} chain(s)`;
  const context = change === null && chains.length === 0
    ? 'Incomplete change and chain data'
    : `${ageText}, ${changeText}, ${chainText}`;
  const leadText = lead.kind === 'monitor' ? 'verify the data first' : `start with ${lead.kind} on ${lead.target}`;
  return `${row.name}: ${context}; ${band.label} TVL suggests a ${days}d launch window, and the ${tier} effort tier says ${leadText}.`;
}

function makePlan(snapshot: Snapshot, row: BoardRow, listedAt: string | null): FarmPlanDetail {
  const age = resolveAge(snapshot.as_of, row, listedAt);
  const chains = Array.isArray(row.chains)
    ? row.chains.filter((chain) => typeof chain === 'string' && chain.trim() !== '')
    : [];
  const flags: string[] = [];
  const change = readChange(row, flags);
  const band = tvlBand(row.tvl_usd);
  const score = round(
    chainPoints(chains.length) * CHAIN_WEIGHT + band.points * BAND_WEIGHT +
      momentumPoints(change) * MOMENTUM_WEIGHT,
    4,
  );
  const effort = tierFor(score);
  const window = estimateWindow(age, change, band);
  const key = categoryKey(row.category);
  const recipe = recipeFor(key);
  const capital = capitalFor(band, effort, window.days);
  const actions = buildActions(chains, key, recipe, band, window.days, capital, effort);
  if (chains.length === 0) flags.push('zero_chains');
  if (age === null) flags.push('missing_age');

  return {
    slug: row.slug,
    name: row.name,
    board_rank: row.rank,
    verdict: row.verdict,
    days_to_window: window.days,
    window_band: window.band,
    confidence: window.confidence,
    effort,
    effort_score: score,
    effort_reasons: effortReasons(chains.length, band, change),
    actions,
    rationale: rationaleFor(row, age, change, chains, band, window.days, effort, actions[0]!),
    effort_adjusted_score: adjustedScore(row, window.days, change, effort),
    suggested_capital_usd: capital,
    data_flags: flags,
  };
}

// One plan per board row, keyed nowhere: the returned array follows the board order exactly.
// Rows without a slug are skipped rather than producing an unattributable plan.
export function buildFarmPlans(snapshot: Snapshot, rows: readonly BoardRow[]): FarmPlanDetail[] {
  const protocols = snapshot && Array.isArray(snapshot.protocols) ? snapshot.protocols : [];
  const listedBySlug = new Map<string, string | null>();
  for (const protocol of protocols) listedBySlug.set(protocol.slug, protocol.listed_at);
  const board = Array.isArray(rows) ? rows : [];
  const plans: FarmPlanDetail[] = [];
  for (const row of board) {
    if (!row || typeof row.slug !== 'string') continue;
    plans.push(makePlan(snapshot, row, listedBySlug.get(row.slug) ?? null));
  }
  return plans;
}

// Handy when a caller needs O(1) lookup before attaching plans to board rows.
export function indexPlans(plans: readonly FarmPlanDetail[]): Map<string, FarmPlanDetail> {
  const index = new Map<string, FarmPlanDetail>();
  for (const plan of plans) index.set(plan.slug, plan);
  return index;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function hasFlag(plan: FarmPlanDetail, flag: string): boolean {
  return plan.data_flags.indexOf(flag) >= 0;
}

// Portfolio view: tier and window counts describe the workload, the median score describes
// the typical opportunity, and top_picks is a deterministic shortlist with explicit tie-breaks.
export function summarizePlans(plans: readonly FarmPlanDetail[]): FarmPlanSummary {
  const list = Array.isArray(plans) ? plans.slice() : [];
  const tiers: TierCounts = { low: 0, medium: 0, high: 0 };
  const windows: WindowCounts = { imminent: 0, near: 0, medium: 0, distant: 0 };
  const flags: FlagCounts = { missing_change: 0, zero_chains: 0, missing_age: 0 };
  const scores: number[] = [];
  let daysTotal = 0;
  let capitalTotal = 0;

  for (const plan of list) {
    tiers[plan.effort]++;
    windows[plan.window_band]++;
    if (hasFlag(plan, 'missing_change')) flags.missing_change++;
    if (hasFlag(plan, 'zero_chains')) flags.zero_chains++;
    if (hasFlag(plan, 'missing_age')) flags.missing_age++;
    scores.push(plan.effort_adjusted_score);
    daysTotal += plan.days_to_window;
    capitalTotal += plan.suggested_capital_usd;
  }

  const ranked = list.slice().sort((a, b) =>
    b.effort_adjusted_score - a.effort_adjusted_score ||
    a.days_to_window - b.days_to_window ||
    a.board_rank - b.board_rank ||
    compareText(a.slug, b.slug),
  );
  const top_picks: TopPick[] = ranked.slice(0, 5).map((plan) => ({
    slug: plan.slug,
    name: plan.name,
    score: plan.effort_adjusted_score,
    effort: plan.effort,
    days_to_window: plan.days_to_window,
    board_rank: plan.board_rank,
  }));

  return {
    total: list.length,
    tiers,
    windows,
    flags,
    average_days_to_window: list.length ? round(daysTotal / list.length, 1) : 0,
    median_score: round(medianOf(scores), 4),
    suggested_capital_usd: capitalTotal,
    top_picks,
  };
}
