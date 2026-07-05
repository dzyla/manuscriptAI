/**
 * Extra eval scorers beyond analysis-agent recall: trim effectiveness,
 * autocomplete quality, and thinking-leak detection. Run via run.ts.
 */
import { trimSectionToLimit, generateCompletion, countWords } from '../../src/services/ai';
import type { AISettings } from '../../src/types';

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
