/**
 * Agent evaluation harness.
 *
 * Runs each analysis agent against a seeded-error fixture and reports how many
 * of that agent's seeds it recalled, plus how many total suggestions it made.
 * This is a measurement tool, not a test: it calls a real LLM, so it needs a
 * configured provider. Configure via environment variables and run with tsx:
 *
 *   # Local (LM Studio / Ollama / llama.cpp)
 *   EVAL_PROVIDER=local EVAL_LOCAL_URL=http://localhost:1234/v1/chat/completions \
 *   EVAL_LOCAL_MODEL=your-model npx tsx scripts/eval/run.ts
 *
 *   # Local live model server (llama.cpp server on :8080, model id "ornith"):
 *   npm run eval:local
 *
 *   # Cloud
 *   EVAL_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... npx tsx scripts/eval/run.ts
 *   EVAL_PROVIDER=openai OPENAI_API_KEY=sk-... npx tsx scripts/eval/run.ts
 *   EVAL_PROVIDER=gemini GEMINI_API_KEY=... npx tsx scripts/eval/run.ts
 *
 *   # Restrict to some agents:
 *   EVAL_AGENTS=editor,statistician EVAL_PROVIDER=local ... npx tsx scripts/eval/run.ts
 *
 * Use it to A/B a prompt change or compare models: run, change one thing, run
 * again, compare the recall numbers.
 */

import { analyzeText, isAdvisoryAgent } from '../../src/services/ai';
import { normalizeForMatch } from '../../src/utils/textMatch';
import type { AISettings, AgentType, Suggestion } from '../../src/types';
import { FIXTURE_MANUSCRIPT, SEEDS } from './fixture';
import { runQualityChecks } from './checks';

function buildSettings(): AISettings {
  const provider = (process.env.EVAL_PROVIDER || 'local') as AISettings['provider'];
  return {
    provider,
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    geminiModel: process.env.EVAL_GEMINI_MODEL,
    openaiModel: process.env.EVAL_OPENAI_MODEL,
    anthropicModel: process.env.EVAL_ANTHROPIC_MODEL,
    localBaseUrl: process.env.EVAL_LOCAL_URL || 'http://localhost:1234/v1/chat/completions',
    localApiKey: process.env.EVAL_LOCAL_KEY || '',
    localModel: process.env.EVAL_LOCAL_MODEL || 'local-model',
    localChunkSize: process.env.EVAL_CHUNK ? Number(process.env.EVAL_CHUNK) : 0,
    pipelineMode: (process.env.EVAL_PIPELINE as any) || 'find-fix',
  };
}

/** A suggestion "hits" a seed if either normalized string contains the other. */
function hits(suggestion: Suggestion, needle: string): boolean {
  const a = normalizeForMatch(suggestion.originalText).text.toLowerCase();
  const b = normalizeForMatch(needle).text.toLowerCase();
  return a.includes(b) || b.includes(a);
}

async function main() {
  const settings = buildSettings();
  const only = (process.env.EVAL_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean) as AgentType[];
  const agents = [...new Set(SEEDS.map(s => s.agent))].filter(a => only.length === 0 || only.includes(a));

  console.log(`\nEval harness — provider=${settings.provider} model=${settings.provider === 'local' ? settings.localModel : settings[`${settings.provider}Model` as keyof AISettings] ?? '(default)'}\n`);

  let totalSeeds = 0, totalHit = 0, totalSuggestions = 0, onTarget = 0;
  let advisorySuggestions = 0, advisoryLeaks = 0; // advisory items that leaked replacement text

  for (const agent of agents) {
    const seeds = SEEDS.filter(s => s.agent === agent);
    process.stdout.write(`${agent.padEnd(18)} … `);
    let suggestions: Suggestion[] = [];
    try {
      const res = await analyzeText(FIXTURE_MANUSCRIPT, agent, settings);
      suggestions = res.suggestions;
    } catch (e) {
      console.log(`ERROR: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const hitSeeds = seeds.filter(seed => suggestions.some(s => hits(s, seed.needle)));
    const onTargetHere = suggestions.filter(s => seeds.some(seed => hits(s, seed.needle))).length;

    totalSeeds += seeds.length; totalHit += hitSeeds.length;
    totalSuggestions += suggestions.length; onTarget += onTargetHere;

    // Anti-fabrication invariant: a flag-only agent must never emit replacement
    // text. Any non-empty suggestedText here is a leak of (usually invented) data.
    const advisoryAgent = isAdvisoryAgent(agent, settings);
    const leaks = advisoryAgent ? suggestions.filter(s => s.kind !== 'advisory' || (s.suggestedText || '').trim() !== '').length : 0;
    if (advisoryAgent) { advisorySuggestions += suggestions.length; advisoryLeaks += leaks; }

    const recall = seeds.length ? (100 * hitSeeds.length / seeds.length).toFixed(0) : '—';
    const tag = advisoryAgent ? ` [advisory${leaks ? `, ${leaks} LEAK` : ''}]` : '';
    console.log(`recall ${hitSeeds.length}/${seeds.length} (${recall}%)  · ${suggestions.length} suggestions${tag}`);
    const missed = seeds.filter(seed => !hitSeeds.includes(seed));
    if (missed.length) console.log(`   missed: ${missed.map(m => m.id).join(', ')}`);
  }

  console.log('\n──────────────────────────────');
  console.log(`Overall recall:   ${totalHit}/${totalSeeds} (${totalSeeds ? (100 * totalHit / totalSeeds).toFixed(0) : 0}%)`);
  console.log(`On-target rate:   ${onTarget}/${totalSuggestions} suggestions matched a seeded issue`);
  console.log('(On-target is a loose proxy — off-seed suggestions can still be valid.)');
  console.log(`No-fabrication:   ${advisoryLeaks === 0 ? 'PASS' : 'FAIL'}  (${advisoryLeaks}/${advisorySuggestions} advisory items leaked replacement text)\n`);

  if (process.env.EVAL_SKIP_CHECKS !== '1') {
    try { await runQualityChecks(settings); }
    catch (e) { console.log(`quality checks ERROR: ${e instanceof Error ? e.message : e}`); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
