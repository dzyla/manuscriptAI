/**
 * Review eval runner. Calls real providers; never run from vitest.
 *
 *   npm run eval:review -- --tier local                 # llama.cpp at :8080, model "ornith", both fixtures
 *   npm run eval:review -- --tier cloud --doc grant     # EVAL_PROVIDER=anthropic|openai|gemini (default anthropic)
 *
 * Env: EVAL_PROVIDER, ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, EVAL_ANTHROPIC_MODEL / EVAL_OPENAI_MODEL /
 * EVAL_GEMINI_MODEL, EVAL_LOCAL_URL, EVAL_LOCAL_MODEL, EVAL_LOCAL_KEY, EVAL_CHUNK (local chunk size, default 2000).
 * Keys are read from the environment only and are never printed or written.
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
import { scoreFindings, scoreProse } from './score';

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
    return {
      provider: 'local',
      localBaseUrl: env.EVAL_LOCAL_URL || 'http://localhost:8080/v1/chat/completions',
      localApiKey: env.EVAL_LOCAL_KEY || '',
      localModel: env.EVAL_LOCAL_MODEL || 'ornith',
      localChunkSize: env.EVAL_CHUNK ? Number(env.EVAL_CHUNK) : 2000,
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
    const out = await runBaseline(fx, settings);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const calls = counter.count();
    const score = scoreFindings(fx, out.findings);
    const prose = scoreProse(fx, out.prose);

    console.log(`── ${fx.id}`);
    console.log(`recall           ${score.hit.length}/${score.planted} (${pct(score.hit.length, score.planted)})`);
    console.log(`false alarms     ${score.falseAlarms.length} on ${fx.traps.length} traps${score.falseAlarms.length ? `  [${score.falseAlarms.map(x => x.trapId).join(', ')}]` : ''}`);
    console.log(`findings         ${score.total} total, ${score.unmatched} unmatched`);
    console.log(`summary mentions ${prose.mentioned.length}/${score.planted} (lenient)`);
    console.log(`LLM calls        ${calls}, ${seconds}s`);
    if (score.missed.length) console.log(`missed           ${score.missed.join(', ')}`);
    if (out.errors.length) console.log(`errors           ${out.errors.join('; ')}`);
    console.log('');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(outDir, `${stamp}-baseline-${args.tier}-${doc}.json`), JSON.stringify({ fixture: fx.id, tier: args.tier, model: modelLabel(settings), calls, seconds, score, prose, errors: out.errors, findings: out.findings, summary: out.prose }, null, 2));
    rows.push(`| ${new Date().toISOString().slice(0, 10)} | baseline | ${args.tier} | ${modelLabel(settings)} | ${doc} | ${score.hit.length}/${score.planted} (${pct(score.hit.length, score.planted)}) | ${score.falseAlarms.length}/${fx.traps.length} | ${score.total} (${score.unmatched} unmatched) | ${prose.mentioned.length}/${score.planted} | ${calls} | ${seconds}s |`);
  }
  counter.restore();
  console.log('Rows for docs/superpowers/plans/2026-07-04-eval-results.md:\n');
  console.log(rows.join('\n'));
}

// vitest imports this file for its pure helpers; only a real CLI run starts the eval.
if (!process.env.VITEST) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
