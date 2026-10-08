/**
 * Extra eval scorers beyond analysis-agent recall: trim effectiveness,
 * autocomplete quality, and thinking-leak detection. Run via run.ts.
 */
import { trimSectionToLimit, generateCompletion, countWords } from '../../src/services/ai';
import { rewriteSentence, checkRewrite } from '../../src/services/proseAudit/rewrite';
import { auditText } from '../../src/services/proseAudit/metrics';
import type { AISettings, VoiceProfile } from '../../src/types';
import { FIXTURE_MANUSCRIPT } from './fixture';

const THINKING_MARKERS = [
  /thinking process/i, /thought process/i, /^\s*sure[!,]/i, /^\s*here('s| is)\b/i,
  /as an ai\b/i, /^\s*\d+\.\s+(?:\*\*|[A-Z])/, /reasoning:/i, /let me think/i,
];

/** True if the text contains a thinking/preamble marker. */
export function looksLikeThinking(text: string): boolean {
  return THINKING_MARKERS.some(re => re.test(text));
}

/** False if the completion is empty or just repeats the context's last sentence. */
export function isForwardContinuation(context: string, completion: string): boolean {
  const c = completion.trim().toLowerCase();
  if (!c) return false;
  const lastSentence = (context.trim().split(/(?<=[.!?])\s+/).pop() || '').trim().toLowerCase();
  if (lastSentence && c.includes(lastSentence)) return false;
  return true;
}

const TRIM_FIXTURE = `We performed a very large number of experiments in order to be able to determine whether the compound was able to inhibit the enzyme. It was observed by us that the compound was in fact able to inhibit the enzyme in a manner that was dose-dependent. In order to be able to confirm this finding, we then went on to perform additional experiments. These additional experiments confirmed that the compound was indeed a potent inhibitor of the enzyme in question, with an IC50 of 42 nM.`;

const AC_FIXTURE = `We measured enzyme activity across a range of inhibitor concentrations. The dose-response curve was sigmoidal, and`;

/** Run trim + autocomplete + thinking-leak checks against the configured model. */
export async function runQualityChecks(settings: AISettings): Promise<void> {
  console.log('\nQuality checks');
  console.log('──────────────────────────────');

  const budget = 40;
  const trimmed = await trimSectionToLimit(TRIM_FIXTURE, 'Results', budget, settings);
  const inW = countWords(TRIM_FIXTURE), outW = countWords(trimmed);
  const trimPass = outW <= budget && outW < inW && !looksLikeThinking(trimmed);
  console.log(`trim         ${trimPass ? 'PASS' : 'FAIL'}  (${inW} -> ${outW} words, budget ${budget})`);
  if (!trimPass) console.log(`   got: ${trimmed.slice(0, 160)}`);

  const completion = await generateCompletion(AC_FIXTURE, settings, undefined, 'Results');
  const acPass = !looksLikeThinking(completion) && isForwardContinuation(AC_FIXTURE, completion) && countWords(completion) > 0;
  console.log(`autocomplete ${acPass ? 'PASS' : 'FAIL'}  (${countWords(completion)} words)`);
  console.log(`   got: ${completion.slice(0, 160)}`);
}

/**
 * Sentences with real tells, taken verbatim from prose already in this repo (no invented samples):
 * the eval fixture, the A2a plan, the A2b writer contract and the small-model design spec.
 * Whitespace is collapsed from the source line wrapping.
 */
const REWRITE_SEEDS = [
  FIXTURE_MANUSCRIPT.split('\n').join(' ').match(/The mechanism, which is complex[^.]*\./)![0],
  "That is normal in grant writing, but the app's grant page budgets, sub-project H's per-section audit and the section-aware agents all key off H1–H3.",
  'Its format changed during A2a development; any further change makes every stored table read as "structure changed" (section 5.3) and be rebuilt without its original shell.',
  'This single misconfiguration is the shared root cause of failures 1, 3, and part of 2.',
];

/**
 * A voice profile built only from text already in the repo (the eval fixture), so the voice-profile prompt path
 * (examples and the target sentence length) is exercised, not just the generic prompt.
 */
const EVAL_PROFILE: VoiceProfile = {
  id: 'eval', name: 'eval fixture', createdAt: 0, sampleWords: 0,
  summary: auditText(FIXTURE_MANUSCRIPT).summary,
  exampleSentences: ['Cells were treated with compound X.', 'We used a t-test.', 'Treatment significantly improved survival.'],
};

/** Rewrite quality: guards pass, severity drops, facts survive, no thinking leak. */
export async function runRewriteChecks(settings: AISettings): Promise<void> {
  console.log('\nRewrite in my voice');
  console.log('──────────────────────────────');
  const sev = (t: string) => auditText(t).sentences.reduce((m, s) => Math.max(m, s.severity), 0);
  let pass = 0;
  for (const sentence of REWRITE_SEEDS) {
    try {
      const r = await rewriteSentence({ sentence, settings, profile: EVAL_PROFILE });
      const guards = checkRewrite(sentence, r.text);
      const ok = guards.ok && r.warnings.length === 0 && !looksLikeThinking(r.text);
      if (ok) pass++;
      console.log(`rewrite      ${ok ? 'PASS' : 'FAIL'}  (severity ${sev(sentence)} -> ${sev(r.text)}${r.retried ? ', retried' : ''}${guards.ok ? '' : `, ${guards.reasons[0]}`})`);
      console.log(`   got: ${r.text.slice(0, 200)}`);
    } catch (e) {
      console.log(`rewrite      FAIL  (${e instanceof Error ? e.message : e})`);
    }
  }
  console.log(`rewrite total ${pass}/${REWRITE_SEEDS.length}`);
}
