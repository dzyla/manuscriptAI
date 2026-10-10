/**
 * Review eval runner. Calls real providers; never run from vitest.
 *
 *   npm run eval:review -- --tier local                 # llama.cpp at :8080, model "ornith", both fixtures
 *   npm run eval:review -- --tier cloud --doc grant     # EVAL_PROVIDER=anthropic|openai|gemini (default anthropic)
 *
 * Env: EVAL_PROVIDER, ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, EVAL_ANTHROPIC_MODEL / EVAL_OPENAI_MODEL /
 * EVAL_GEMINI_MODEL, EVAL_LOCAL_URL, EVAL_LOCAL_MODEL, EVAL_LOCAL_KEY, EVAL_CHUNK (local chunk size, default 2000).
 * Keys are read from the environment only and are never printed or written.
 * LLM calls counts POST requests, so SDK retries count as calls.
 *
 * Prints a per-fixture report and one markdown table row per fixture for
 * docs/superpowers/plans/2026-07-04-eval-results.md, and writes the full result to
 * scripts/eval/review/results/<timestamp>-<system>-<tier>-<doc>.json (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AISettings } from '../../../src/types';
import { GRANT_FIXTURE } from './fixtures/grant';
import { MANUSCRIPT_FIXTURE } from './fixtures/manuscript';
import type { ReviewFixture } from './fixtures/types';
import { scoreBySource, scoreFindings, scoreProse } from './score';

export interface EvalArgs {
  tier: 'cloud' | 'local';
  docs: ('grant' | 'manuscript')[];
}

export function parseArgs(argv: string[]): EvalArgs {
  const get = (name: string): string | undefined => {
    const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0) return undefined;
    return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  };
  const tier = get('tier') ?? 'local';
  if (tier !== 'cloud' && tier !== 'local') throw new Error(`--tier must be cloud or local, got "${tier}"`);
  const doc = get('doc') as 'grant' | 'manuscript' | undefined;
  if (doc !== undefined && doc !== 'grant' && doc !== 'manuscript') throw new Error(`--doc must be grant or manuscript, got "${String(doc)}"`);
  return { tier, docs: doc ? [doc] : ['grant', 'manuscript'] };
}

export function buildSettings(tier: 'cloud' | 'local', env: Record<string, string | undefined>): AISettings {
  if (tier === 'local') {
    const chunk = env.EVAL_CHUNK ? Number(env.EVAL_CHUNK) : 2000;
    if (!Number.isFinite(chunk)) throw new Error('EVAL_CHUNK must be a number');
    return {
      provider: 'local',
      localBaseUrl: env.EVAL_LOCAL_URL || 'http://localhost:8080/v1/chat/completions',
      localApiKey: env.EVAL_LOCAL_KEY || '',
      localModel: env.EVAL_LOCAL_MODEL || 'ornith',
      localChunkSize: chunk,
    };
  }
  const provider = (env.EVAL_PROVIDER || 'anthropic') as AISettings['provider'];
  if (provider === 'local') throw new Error('The cloud tier needs EVAL_PROVIDER=anthropic, openai or gemini.');
  return {
    provider,
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    openaiApiKey: env.OPENAI_API_KEY || '',
    geminiApiKey: env.GEMINI_API_KEY || '',
    anthropicModel: env.EVAL_ANTHROPIC_MODEL,
    openaiModel: env.EVAL_OPENAI_MODEL,
    geminiModel: env.EVAL_GEMINI_MODEL,
    localBaseUrl: '',
    localApiKey: '',
    localModel: '',
    localChunkSize: 0,
  };
}

export function modelLabel(s: AISettings): string {
  if (s.provider === 'local') return `local/${s.localModel}`;
  const model = s.provider === 'anthropic' ? s.anthropicModel : s.provider === 'openai' ? s.openaiModel : s.geminiModel;
  return `${s.provider}/${model ?? '(default)'}`;
}

export function redactSecrets(s: string, keys: string[] = []): string {
  let out = s.replace(/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})/g, '[redacted]');
  for (const k of keys) if (k) out = out.split(k).join('[redacted]');
  return out;
}

/** Env var name of the selected cloud provider's missing key, or null when usable (always null for local). */
export function missingKey(s: AISettings): string | null {
  if (s.provider === 'anthropic') return s.anthropicApiKey ? null : 'ANTHROPIC_API_KEY';
  if (s.provider === 'openai') return s.openaiApiKey ? null : 'OPENAI_API_KEY';
  if (s.provider === 'gemini') return s.geminiApiKey ? null : 'GEMINI_API_KEY';
  return null;
}

/** Count POST requests (one per LLM call on every provider path) by wrapping `target.fetch`. */
export function installCallCounter(target: { fetch: typeof fetch } = globalThis): { count(): number; reset(): void; restore(): void } {
  const original = target.fetch;
  let n = 0;
  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST') n++;
    return original(input, init);
  }) as typeof fetch;
  return { count: () => n, reset: () => { n = 0; }, restore: () => { target.fetch = original; } };
}

const FIXTURES: Record<'grant' | 'manuscript', ReviewFixture> = { grant: GRANT_FIXTURE, manuscript: MANUSCRIPT_FIXTURE };
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = buildSettings(args.tier, process.env);
  const missing = missingKey(settings);
  if (missing) throw new Error(`Missing ${missing} for EVAL_PROVIDER=${settings.provider}.`);
  const secrets = [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY, process.env.EVAL_LOCAL_KEY].filter((k): k is string => !!k);
  const redact = (x: string) => redactSecrets(x, secrets);
  let failed = false;
  const counter = installCallCounter();
  const { runBaseline } = await import('./baseline');
  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(outDir, { recursive: true });
  const rows: string[] = [];

  console.log(`\nReview eval — system=baseline tier=${args.tier} model=${modelLabel(settings)}${args.tier === 'local' ? ` chunk=${settings.localChunkSize}` : ''}\n`);
  for (const doc of args.docs) {
    const fx = FIXTURES[doc];
    counter.reset();
    const t0 = Date.now();
    let out;
    try {
      out = await runBaseline(fx, settings);
    } catch (e) {
      failed = true;
      console.log(`── ${fx.id}`);
      console.log(`run failed: ${redact(e instanceof Error ? e.message : String(e))}\n`);
      continue;
    }
    out.errors = out.errors.map(redact);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const calls = counter.count();
    const score = scoreFindings(fx, out.findings);
    // The edit agent leaves Review in v2, so the comparable baseline excludes it.
    const noEditor = scoreFindings(fx, out.findings.filter(f => f.source !== 'editor'));
    const bySource = scoreBySource(fx, out.findings);
    const prose = scoreProse(fx, out.prose);

    console.log(`── ${fx.id}`);
    const recallLine = (r: typeof score) => `${r.hit.length}/${r.planted} (${pct(r.hit.length, r.planted)})`;
    console.log(`recall           ${recallLine(score)} all, ${recallLine(noEditor)} excl. editor`);
    console.log(`false alarms     ${score.falseAlarms.length} all, ${noEditor.falseAlarms.length} excl. editor, on ${fx.traps.length} traps${score.falseAlarms.length ? `  [${score.falseAlarms.map(x => x.trapId).join(', ')}]` : ''}`);
    console.log(`findings         ${score.total} total (${noEditor.total} excl. editor), ${score.unmatched} unmatched (${noEditor.unmatched} excl. editor)`);
    console.log('                 unmatched includes real weaknesses that were not planted, so it is not pure noise.');
    console.log(`by source        ${Object.entries(bySource).map(([k, v]) => `${k}: ${v.total} total, ${v.hits} hits, ${v.falseAlarms} false alarms`).join(' | ') || '(none)'}`);
    console.log(`summary mentions ${prose.mentioned.length}/${score.planted} (lenient)`);
    console.log(`LLM calls        ${calls}, ${seconds}s`);
    if (score.missed.length) console.log(`missed           ${score.missed.join(', ')}`);
    if (out.errors.length) console.log(`errors           ${out.errors.join('; ')}`);
    console.log('');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(outDir, `${stamp}-baseline-${args.tier}-${doc}.json`), JSON.stringify({ fixture: fx.id, tier: args.tier, model: modelLabel(settings), calls, seconds, score, scoreExcludingEditor: noEditor, bySource, prose, errors: out.errors, findings: out.findings, summary: out.prose }, null, 2));
    const row = `| ${new Date().toISOString().slice(0, 10)} | baseline | ${args.tier} | ${modelLabel(settings)} | ${doc} | ${recallLine(score)} all (${recallLine(noEditor)} excl. editor) | ${score.falseAlarms.length} all (${noEditor.falseAlarms.length} excl. editor)/${fx.traps.length} | ${score.total} all (${noEditor.total} excl. editor), ${score.unmatched} unmatched (${noEditor.unmatched} excl. editor) | ${prose.mentioned.length}/${score.planted} | ${calls} | ${seconds}s |`;
    rows.push(row);
    console.log(`${row}\n`);
  }
  counter.restore();
  console.log('Rows for docs/superpowers/plans/2026-07-04-eval-results.md:\n');
  console.log(rows.join('\n'));
  if (failed) process.exitCode = 1;
}

// vitest imports this file for its pure helpers; only a real CLI run starts the eval.
if (!process.env.VITEST) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
