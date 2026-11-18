// Entry point: reads a token snapshot, builds the radar board, and writes output artifacts.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSnapshot, buildRadar, boardIssue, dataScript, isRankablePreToken } from './lib/model.ts';
import type { Protocol, Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

function usage(): never {
  console.error('Usage: node main.ts [--input <file|dir>] [--output <dir>]');
  process.exit(1);
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      if (i + 1 >= argv.length) usage();
      input = argv[++i];
    } else if (a === '--output') {
      if (i + 1 >= argv.length) usage();
      output = argv[++i];
    } else {
      usage();
    }
  }
  return { input, output };
}

function resolveInput(path: string): string {
  try {
    const st = statSync(path);
    if (st.isDirectory()) return join(path, 'snapshot.json');
  } catch {
    // let read fail with a clear message below
  }
  return path;
}

function copyDirAll(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirAll(s, d);
    } else if (entry.isFile()) {
      copyFileSync(s, d);
    }
  }
}

function copyScreenshotsMaybe(srcDir: string, outDir: string): void {
  if (!existsSync(srcDir)) {
    console.warn('Warning: screenshots/ directory not found, skipping copy');
    return;
  }
  let entries;
  try {
    entries = readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isFile());
  } catch {
    console.warn('Warning: screenshots/ could not be read, skipping copy');
    return;
  }
  if (entries.length === 0) {
    console.warn('Warning: screenshots/ has no files, skipping copy');
    return;
  }
  const dest = join(outDir, 'screenshots');
  mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    copyFileSync(join(srcDir, e.name), join(dest, e.name));
  }
}

// ---------------------------------------------------------------- input hardening
// The sealed snapshot is clean, but the entry must not fall over on empty fields, zero/negative
// TVL or market caps, repeated slugs, watchlist entries that name nothing, or unicode lookalikes.
// Sanitizing once up front keeps every downstream pass simple and deterministic.

const ZERO_WIDTH_OR_CONTROL = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
const MAX_SWEEP_CANDIDATES = 160;

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// NFKC folds compatibility/unicode variants; zero-width and control characters are dropped
// (they are invisible, not separators), and real whitespace becomes DefiLlama's '-' separator.
// Plain ASCII slugs are unchanged.
function canonicalSlug(raw: string): string {
  return raw.normalize('NFKC').replace(ZERO_WIDTH_OR_CONTROL, '').trim().toLowerCase().replace(/\s+/g, '-');
}

function cleanText(raw: string): string {
  return raw.normalize('NFKC').replace(ZERO_WIDTH_OR_CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

interface SanitizeReport {
  dropped_protocols: number;
  invalid_mcaps: number;
  duplicate_slugs: number;
  missing_watchlist: number;
  normalized_slugs: number;
  empty_fields: number;
  clamped_floor: boolean;
}

// Higher is better when two records share a canonical slug: prefer the larger, more complete,
// lexicographically earlier record so deduplication never depends on input ordering beyond that.
function duplicateScore(p: Protocol): number {
  return (p.mcap_usd !== null ? 4 : 0) + (p.gecko_id !== null ? 2 : 0) +
    (p.symbol !== null ? 1 : 0) + (p.listed_at !== null ? 1 : 0);
}

function betterDuplicate(a: Protocol, b: Protocol): boolean {
  if (a.tvl_usd !== b.tvl_usd) return a.tvl_usd > b.tvl_usd;
  const fa = duplicateScore(a), fb = duplicateScore(b);
  if (fa !== fb) return fa > fb;
  return compareCodeUnit(a.name, b.name) < 0;
}

function sanitizeSnapshot(src: Snapshot): { snapshot: Snapshot; report: SanitizeReport } {
  const report: SanitizeReport = {
    dropped_protocols: 0, invalid_mcaps: 0, duplicate_slugs: 0,
    missing_watchlist: 0, normalized_slugs: 0, empty_fields: 0, clamped_floor: false,
  };

  const protocols: Protocol[] = [];
  const indexBySlug = new Map<string, number>();
  const keptBySlug = new Map<string, Protocol>();

  // One batched pass builds the usable protocol list, the slug index and the cleanup counts.
  for (let i = 0; i < src.protocols.length; i++) {
    const p = src.protocols[i]!;
    const slug = canonicalSlug(p.slug);
    if (!slug || !Number.isFinite(p.tvl_usd) || p.tvl_usd <= 0) {
      report.dropped_protocols++;
      continue;
    }
    if (slug !== p.slug) report.normalized_slugs++;

    let mcap = p.mcap_usd;
    if (mcap !== null && (!Number.isFinite(mcap) || mcap <= 0)) {
      mcap = null; // a zero/negative "market cap" is missing data, not a comparable
      report.invalid_mcaps++;
    }
    const change = p.change_7d !== null && Number.isFinite(p.change_7d) ? p.change_7d : null;
    const normName = cleanText(p.name);
    if (!normName) report.empty_fields++;
    const normCategory = p.category === null ? null : (cleanText(p.category) || null);
    const normListed = p.listed_at === null ? null : (cleanText(p.listed_at) || null);
    const normGecko = p.gecko_id === null ? null : (cleanText(p.gecko_id) || null);
    const normSymbol = p.symbol === null ? null : (cleanText(p.symbol) || null);

    const chains: string[] = [];
    for (const rawChain of p.chains) {
      const chain = cleanText(rawChain);
      if (chain && !chains.includes(chain)) chains.push(chain); // chains are tiny; avoid a Set per row
    }

    const clean: Protocol = {
      slug, name: normName || slug, category: normCategory, chains,
      tvl_usd: p.tvl_usd, change_7d: change, mcap_usd: mcap,
      listed_at: normListed, gecko_id: normGecko, symbol: normSymbol,
    };

    const prior = keptBySlug.get(slug);
    if (prior !== undefined) {
      report.duplicate_slugs++;
      if (!betterDuplicate(clean, prior)) continue; // first occurrence wins a full tie
      protocols[indexBySlug.get(slug)!] = clean;
      keptBySlug.set(slug, clean);
      continue;
    }
    indexBySlug.set(slug, protocols.length);
    keptBySlug.set(slug, clean);
    protocols.push(clean);
  }

  const wanted = new Set<string>();
  for (const raw of src.watchlist) {
    const slug = canonicalSlug(raw);
    if (!slug || wanted.has(slug)) continue;
    if (!keptBySlug.has(slug)) {
      report.missing_watchlist++; // cannot price a slug the snapshot never defines
      continue;
    }
    if (slug !== raw) report.normalized_slugs++;
    wanted.add(slug);
  }
  const watchlist = [...wanted].sort(compareCodeUnit);

  const asOf = cleanText(src.as_of);
  const source = cleanText(src.source);
  if (!asOf || !source) report.empty_fields++;
  const floorUsd = Number.isFinite(src.floor_usd) && src.floor_usd >= 0 ? src.floor_usd : 0;
  if (floorUsd !== src.floor_usd) report.clamped_floor = true;

  return {
    snapshot: {
      as_of: asOf || '1970-01-01',
      source: source || 'unknown',
      floor_usd: floorUsd,
      protocols,
      watchlist,
    },
    report,
  };
}

// ---------------------------------------------------------------- launch-candidate sweep
interface SweepCandidate {
  slug: string;
  score: number;
  tvl: number;
  age: number | null;
}

// Launch-window anchors in days without a token: the score rises smoothly with time at risk of
// launching, rather than jumping at a few hard cut-offs. Between anchors we interpolate linearly.
const WINDOW_EDGES: readonly number[] = [0, 90, 180, 365, 730, 1460];
const WINDOW_SCORES: readonly number[] = [0.25, 0.40, 0.55, 0.70, 0.85, 0.95];

function windowScore(age: number | null, cache: Map<number | string, number>): number {
  const key: number | string = age === null ? 'unknown' : age;
  const hit = cache.get(key);
  if (hit !== undefined) return hit; // ages repeat across protocols; parse/interpolate once
  const a = age === null ? 180 : age;
  let score = WINDOW_SCORES[WINDOW_SCORES.length - 1]!;
  for (let i = 1; i < WINDOW_EDGES.length; i++) {
    if (a <= WINDOW_EDGES[i]!) {
      const lo = WINDOW_EDGES[i - 1]!, hi = WINDOW_EDGES[i]!;
      const t = (a - lo) / (hi - lo);
      score = WINDOW_SCORES[i - 1]! + t * (WINDOW_SCORES[i]! - WINDOW_SCORES[i - 1]!);
      break;
    }
  }
  score = Math.round(score * 1e6) / 1e6;
  cache.set(key, score);
  return score;
}

function cachedUtcDay(day: string, cache: Map<string, number>): number {
  let epoch = cache.get(day);
  if (epoch === undefined) {
    epoch = Date.parse(day + 'T00:00:00Z');
    cache.set(day, epoch); // NaN is cached too: bad dates stay bad without reparsing
  }
  return epoch;
}

// Scan the snapshot once for launch candidates. Watchlist slugs are always kept; every other
// row is a below-floor, rankable pre-token scored on its launch window and size relative to the
// floor. Ties are broken by TVL, age and canonical slug so the board never depends on sweep order.
function sweepLaunchCandidates(snapshot: Snapshot, limit = MAX_SWEEP_CANDIDATES): Set<string> {
  const selected = new Set<string>(snapshot.watchlist); // O(1) watchlist membership tests
  const dayCache = new Map<string, number>();
  const ageCache = new Map<number | string, number>();
  const asOf = cachedUtcDay(snapshot.as_of, dayCache);
  const floor = snapshot.floor_usd > 0 ? snapshot.floor_usd : 1;
  const candidates: SweepCandidate[] = [];

  for (let i = 0; i < snapshot.protocols.length; i++) {
    const p = snapshot.protocols[i]!;
    if (selected.has(p.slug) || !isRankablePreToken(p) || p.tvl_usd >= floor) continue;

    let age: number | null = null;
    if (p.listed_at !== null && Number.isFinite(asOf)) {
      const listed = cachedUtcDay(p.listed_at, dayCache);
      if (Number.isFinite(listed)) age = Math.max(0, Math.floor((asOf - listed) / 86400000));
    }
    // log10 of the TVL/floor ratio maps 1%..100% of the floor onto 0..1 for the size signal.
    const sizeSignal = Math.min(1, Math.max(0, Math.log10(Math.max(1, p.tvl_usd) / floor) + 2));
    const score = Math.round((windowScore(age, ageCache) * 0.75 + sizeSignal * 0.25) * 1e6) / 1e6;
    candidates.push({ slug: p.slug, score, tvl: p.tvl_usd, age });
  }

  candidates.sort((a, b) => b.score - a.score || b.tvl - a.tvl ||
    (a.age ?? Number.MAX_SAFE_INTEGER) - (b.age ?? Number.MAX_SAFE_INTEGER) ||
    compareCodeUnit(a.slug, b.slug));
  for (let i = 0; i < Math.min(limit, candidates.length); i++) selected.add(candidates[i]!.slug);
  return selected;
}

function main(): void {
  const args = parseArgs(process.argv);
  const inputPath = resolveInput(args.input);
  const outputDir = resolve(args.output);

  let text: string;
  try {
    text = readFileSync(inputPath, 'utf8');
  } catch (err) {
    console.error(`Failed to read snapshot: ${inputPath}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (text.trim() === '') {
    console.error(`Failed to read snapshot: ${inputPath} is empty`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseSnapshot(text);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { snapshot, report } = sanitizeSnapshot(parsed);
  if (snapshot.protocols.length === 0) {
    console.error(`Snapshot has no usable protocols to rank: ${inputPath}`);
    process.exit(1);
  }
  const selected = sweepLaunchCandidates(snapshot);
  const { board, radar } = buildRadar(snapshot, selected);
  const issue = boardIssue(board, snapshot);
  if (issue) {
    console.error(`Refusing board: ${issue}`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'board.json'), JSON.stringify({ rows: board }, null, 2) + '\n', 'utf8');
  writeFileSync(join(outputDir, 'data.js'), dataScript(radar), 'utf8');

  copyDirAll(join(process.cwd(), 'dashboard'), join(outputDir, 'dashboard'));
  copyScreenshotsMaybe(join(process.cwd(), 'screenshots'), outputDir);

  const dossier = buildDossier(outputDir, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  writeFileSync(join(outputDir, 'dossier.json'), dossier);

  const changes = report.dropped_protocols + report.invalid_mcaps + report.duplicate_slugs +
    report.missing_watchlist + report.normalized_slugs + report.empty_fields + (report.clamped_floor ? 1 : 0);
  if (changes > 0) {
    console.warn(`sanitized ${changes} snapshot issue(s): ${JSON.stringify(report)}`);
  }
  console.log(`protocols=${snapshot.protocols.length} watchlist=${snapshot.watchlist.length} sweep=${selected.size} rows=${board.length}`);
}

main();
