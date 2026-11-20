// Entry point: read a token snapshot, build the radar board, and write all output artifacts.
// The file is deliberately split into small phases (CLI, input, sanitizing, sweep, emit) so each
// invariant is checked in exactly one place and the emitted JSON keeps its original shape.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { boardIssue, buildRadar, dataScript, isRankablePreToken, parseSnapshot } from './lib/model.ts';
import type { BoardRow, Protocol, RadarPayload, Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const DEFAULT_INPUT = '/input/snapshot.json';
const DEFAULT_OUTPUT = '/output';
const SNAPSHOT_FILENAME = 'snapshot.json';
const ZERO_WIDTH_OR_CONTROL = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
const MAX_SWEEP_CANDIDATES = 160;
const MAX_DAY_CACHE = 10_000;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(): never {
  console.error('Usage: node main.ts [--input <file|dir>] [--output <dir>]');
  process.exit(1);
}

interface CliArgs {
  input: string;
  output: string;
}

// Both "--input file" and "--input=file" are accepted; empty values and unknown flags are rejected
// early instead of being reported later as confusing file-system errors.
function parseArgs(argv: string[]): CliArgs {
  let input = DEFAULT_INPUT;
  let output = process.env.MAKEFUN_OUTPUT_DIR || DEFAULT_OUTPUT;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    let flag = arg;
    let inlineValue: string | undefined;
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals > 2) {
      flag = arg.slice(0, equals);
      inlineValue = arg.slice(equals + 1);
    }
    if (flag !== '--input' && flag !== '--output') {
      // Unknown flags happen when a harness passes extra options; the starter tolerated them.
      // Ignore the flag (and its separate value, if any) instead of refusing the whole run.
      if (inlineValue === undefined && i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) i++;
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined || value === '') usage();
    if (flag === '--input') input = value;
    else output = value;
  }
  return { input, output };
}

// A directory argument is shorthand for its snapshot.json; other special files are not readable
// input. When stat fails we keep the original path so readFileSync can report the real reason.
function resolveInput(path: string): string {
  let isDirectory = false;
  let isFile = false;
  try {
    const stat = statSync(path);
    isDirectory = stat.isDirectory();
    isFile = stat.isFile();
  } catch {
    return path;
  }
  if (isDirectory) return join(path, SNAPSHOT_FILENAME);
  if (!isFile) throw new Error(`Snapshot path is not a regular file or directory: ${path}`);
  return path;
}

// True when `child` is `parent` itself or lives underneath it. Paths are resolved first so ".."
// segments and relative spellings cannot hide a nested destination.
function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

// Copying a source tree into itself would recurse until the path limit is hit (for example when
// --output points inside dashboard/). Refuse that up front, at every recursion level.
function assertNotCopyingIntoItself(src: string, dest: string): void {
  if (isWithin(src, dest)) {
    throw new Error(`Refusing to copy ${resolve(src)} into itself: ${resolve(dest)}`);
  }
}

function copyDirAll(src: string, dest: string): void {
  assertNotCopyingIntoItself(src, dest);
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const source = join(src, entry.name);
    const target = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirAll(source, target);
    } else if (entry.isFile()) {
      copyFileSync(source, target);
    }
    // Symlinks and special files are intentionally not followed or copied.
  }
}

function copyScreenshotsMaybe(srcDir: string, outDir: string): void {
  if (!existsSync(srcDir)) {
    console.warn('Warning: screenshots/ directory not found, skipping copy');
    return;
  }
  let files;
  try {
    files = readdirSync(srcDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  } catch {
    console.warn('Warning: screenshots/ could not be read, skipping copy');
    return;
  }
  if (files.length === 0) {
    console.warn('Warning: screenshots/ has no files, skipping copy');
    return;
  }
  const dest = join(outDir, 'screenshots');
  assertNotCopyingIntoItself(srcDir, dest);
  mkdirSync(dest, { recursive: true });
  for (const entry of files) {
    copyFileSync(join(srcDir, entry.name), join(dest, entry.name));
  }
}

// ---------------------------------------------------------------- input hardening
// The sealed snapshot is clean, but the entry must not fall over on empty fields, zero/negative
// TVL or market caps, repeated slugs, watchlist entries that name nothing, or unicode lookalikes.
// Sanitizing once up front keeps every downstream pass simple and deterministic.

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
  const scoreA = duplicateScore(a), scoreB = duplicateScore(b);
  if (scoreA !== scoreB) return scoreA > scoreB;
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
  const sourceProtocols = Array.isArray(src.protocols) ? src.protocols : [];
  const sourceWatchlist = Array.isArray(src.watchlist) ? src.watchlist : [];

  // One batched pass builds the usable protocol list, the slug index and the cleanup counts.
  for (const p of sourceProtocols) {
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
    for (const rawChain of Array.isArray(p.chains) ? p.chains : []) {
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
  for (const raw of sourceWatchlist) {
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
  const a = age === null || !Number.isFinite(age) ? 180 : age;
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
    if (cache.size >= MAX_DAY_CACHE) cache.clear(); // long-lived callers must not leak memory
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
  const take = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  const candidates: SweepCandidate[] = [];

  for (const p of snapshot.protocols) {
    if (selected.has(p.slug) || !isRankablePreToken(p) || p.tvl_usd >= floor) continue;

    let age: number | null = null;
    if (p.listed_at !== null && Number.isFinite(asOf)) {
      const listed = cachedUtcDay(p.listed_at, dayCache);
      if (Number.isFinite(listed)) age = Math.max(0, Math.floor((asOf - listed) / 86_400_000));
    }
    // log10 of the TVL/floor ratio maps 1%..100% of the floor onto 0..1 for the size signal.
    const sizeSignal = Math.min(1, Math.max(0, Math.log10(Math.max(1, p.tvl_usd) / floor) + 2));
    const score = Math.round((windowScore(age, ageCache) * 0.75 + sizeSignal * 0.25) * 1e6) / 1e6;
    candidates.push({ slug: p.slug, score, tvl: p.tvl_usd, age });
  }

  candidates.sort((a, b) => b.score - a.score || b.tvl - a.tvl ||
    (a.age ?? Number.MAX_SAFE_INTEGER) - (b.age ?? Number.MAX_SAFE_INTEGER) ||
    compareCodeUnit(a.slug, b.slug));
  for (let i = 0; i < Math.min(take, candidates.length); i++) selected.add(candidates[i]!.slug);
  return selected;
}

// ---------------------------------------------------------------- phases
function loadSnapshot(path: string): Snapshot {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read snapshot: ${path}\n${describeError(err)}`);
  }
  if (text.trim() === '') throw new Error(`Failed to read snapshot: ${path} is empty`);
  try {
    return parseSnapshot(text);
  } catch (err) {
    throw new Error(describeError(err));
  }
}

function reportSanitizing(report: SanitizeReport): void {
  const changes = report.dropped_protocols + report.invalid_mcaps + report.duplicate_slugs +
    report.missing_watchlist + report.normalized_slugs + report.empty_fields + (report.clamped_floor ? 1 : 0);
  if (changes > 0) console.warn(`sanitized ${changes} snapshot issue(s): ${JSON.stringify(report)}`);
}

function emitArtifacts(outputDir: string, board: BoardRow[], radar: RadarPayload, report: SanitizeReport): void {
  const dashboardSrc = join(process.cwd(), 'dashboard');
  const screenshotsSrc = join(process.cwd(), 'screenshots');
  // Validate destinations before creating anything, so a bad --output cannot damage the sources.
  assertNotCopyingIntoItself(dashboardSrc, join(outputDir, 'dashboard'));
  assertNotCopyingIntoItself(screenshotsSrc, join(outputDir, 'screenshots'));

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'board.json'), JSON.stringify({ rows: board }, null, 2) + '\n', 'utf8');
  writeFileSync(join(outputDir, 'data.js'), dataScript(radar), 'utf8');

  copyDirAll(dashboardSrc, join(outputDir, 'dashboard'));
  copyScreenshotsMaybe(screenshotsSrc, outputDir);

  const dossier = buildDossier(outputDir, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  writeFileSync(join(outputDir, 'dossier.json'), dossier);

  reportSanitizing(report);
}

function main(): void {
  const args = parseArgs(process.argv);
  const inputPath = resolveInput(args.input);
  const outputDir = resolve(args.output);

  const parsed = loadSnapshot(inputPath);
  const { snapshot, report } = sanitizeSnapshot(parsed);
  if (snapshot.protocols.length === 0) {
    throw new Error(`Snapshot has no usable protocols to rank: ${inputPath}`);
  }

  const selected = sweepLaunchCandidates(snapshot);
  const { board, radar } = buildRadar(snapshot, selected);
  const issue = boardIssue(board, snapshot);
  if (issue) throw new Error(`Refusing board: ${issue}`);

  emitArtifacts(outputDir, board, radar, report);
  console.log(`protocols=${snapshot.protocols.length} watchlist=${snapshot.watchlist.length} sweep=${selected.size} rows=${board.length}`);
}

// Expected errors above already print precise messages; this catch turns unexpected file-system
// or serialization failures into a clean one-line error instead of a raw stack trace.
try {
  main();
} catch (err) {
  console.error(describeError(err));
  process.exit(1);
}
