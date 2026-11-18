// Entry point: reads a token snapshot, builds the radar board, and writes output artifacts.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSnapshot, buildRadar, boardIssue, dataScript } from './lib/model.ts';
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

  let snapshot;
  try {
    snapshot = parseSnapshot(text);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { board, radar } = buildRadar(snapshot);
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

  console.log(`protocols=${snapshot.protocols.length} watchlist=${snapshot.watchlist.length} rows=${board.length}`);
}

main();
