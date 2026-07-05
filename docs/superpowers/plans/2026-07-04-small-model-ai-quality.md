# Small-Model AI Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app's AI output correct and useful on the user's small local model (`ornith-9b-mtp-kl-Q4_K_M.gguf` via llama.cpp at `http://localhost:8080/v1/chat/completions`): stop thinking from leaking, make section-trimming actually shorten, tune prompts empirically, and make autocomplete relevant.

**Architecture:** All LLM calls funnel through `callLLM` → `callLocalLLM` in `src/services/ai.ts`. The root fix is sending `chat_template_kwargs: { enable_thinking: false }` on the local request body (verified live to suppress the model's always-on `reasoning_content`). On top of that: a measure-and-retry loop for trimming built around pure helpers (`countWords`, `bestTrimCandidate`), a `stop`-sequence passthrough for short autocomplete, and an extended `scripts/eval/` harness (`npm run eval:local`) that grades trim/autocomplete/thinking-leak against the live model so prompt tuning is evidence-based.

**Tech Stack:** TypeScript, React 19, TipTap/ProseMirror, Vitest, tsx, OpenAI-compatible local LLM (llama.cpp build `b9827`).

## Global Constraints

- Type-check gate: `npm run lint` (`tsc --noEmit`) must pass. No `any`-loosening beyond existing patterns.
- Unit tests: `npm run test` (Vitest) must pass. New pure helpers get unit tests.
- Live model for eval/manual verification: `http://localhost:8080/v1/chat/completions`, model id `ornith` (server accepts a substring alias), OpenAI-compatible.
- Prose rule already enforced by existing prompts: no em/en dashes. Do not regress it.
- Additive body fields only — unknown JSON fields are ignored by servers that don't support them; never remove the existing `enable_thinking`/`think` flags (other backends read them).
- Commit after each task. Branch is `feat/review-crew-overhaul` (already checked out); do not create a new branch.

---

### Task 1: Suppress thinking on local requests

**Files:**
- Modify: `src/services/ai.ts:680-688` (local `baseBody`), `src/services/ai.ts:836-874` (`stripThinkingBlocks`)
- Test: `src/services/ai.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature changes. `stripThinkingBlocks` (module-internal) gains coverage for a bare `Thinking Process:` preamble and a non-bold numbered-analysis preamble. The local request body carries `chat_template_kwargs: { enable_thinking: false }`.

- [ ] **Step 1: Add a failing test for a bare numbered (non-bold) thinking preamble**

`stripThinkingBlocks` is not exported. Export it for testing by changing its declaration at `src/services/ai.ts:836` from `function stripThinkingBlocks(` to `export function stripThinkingBlocks(`.

Add to `src/services/ai.test.ts` (import `stripThinkingBlocks` in the existing top import block from `./ai`):

```ts
describe('stripThinkingBlocks', () => {
  it('removes a bare "Thinking Process:" preamble and keeps the answer', () => {
    const input = 'Thinking Process:\nThe user wants a greeting.\n\nHello there.';
    expect(stripThinkingBlocks(input)).toBe('Hello there.');
  });
  it('removes a non-bold numbered analysis preamble', () => {
    const input = '1. Analyze the request.\n2. Draft the reply.\n\nThe final answer.';
    expect(stripThinkingBlocks(input)).toBe('The final answer.');
  });
  it('leaves normal prose untouched', () => {
    expect(stripThinkingBlocks('A clean sentence.')).toBe('A clean sentence.');
  });
});
```

- [ ] **Step 2: Run the test to verify the non-bold numbered case fails**

Run: `npx vitest run src/services/ai.test.ts -t stripThinkingBlocks`
Expected: the "non-bold numbered analysis" case FAILS (current regex `/^\d+\.\s+\*\*/` only matches **bold** numbered steps). The other two pass.

- [ ] **Step 3: Extend the preamble detection to non-bold numbered lists**

In `stripThinkingBlocks` (`src/services/ai.ts`), change the two occurrences of the bold-only numbered check `/^\d+\.\s+\*\*/` (at lines ~853 and ~864) to also match plain numbered analysis lines. Replace both with `/^\d+\.\s+(?:\*\*|[A-Z])/` (a numbered item that starts with bold **or** a capitalized analysis word). Keep the `THINKING_SECTION` regex as-is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/ai.test.ts -t stripThinkingBlocks`
Expected: all three PASS.

- [ ] **Step 5: Add `chat_template_kwargs` to the local request body**

In `src/services/ai.ts`, edit the `baseBody` object (lines 680-688) to add the verified suppression flag alongside the existing ones:

```ts
  const baseBody = {
    model: settings.localModel,
    messages,
    temperature: temperature ?? 0.3,
    max_tokens: resolvedMaxTokens,
    // Disable thinking/reasoning mode. Different servers read different flags:
    // top-level enable_thinking/think (Ollama, some vLLM builds) and
    // chat_template_kwargs.enable_thinking (llama.cpp b9827+ — the one that
    // actually stops ornith-9b's always-on "Thinking Process"). All additive.
    enable_thinking: false,
    think: false,
    chat_template_kwargs: { enable_thinking: false },
  };
```

- [ ] **Step 6: Verify live that thinking is gone**

With the local server running, run:

```bash
curl -s -m 60 http://localhost:8080/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"ornith","messages":[{"role":"user","content":"Reply with exactly one word: ok"}],"max_tokens":300,"chat_template_kwargs":{"enable_thinking":false}}' \
  | python3 -c "import sys,json; m=json.load(sys.stdin)['choices'][0]['message']; print('content=',repr(m.get('content'))); print('reasoning=',repr(m.get('reasoning_content')))"
```

Expected: `content= 'ok'` and `reasoning= None`. This confirms the flag path the app now sends.

- [ ] **Step 7: Type-check and commit**

```bash
npm run lint && npx vitest run src/services/ai.test.ts
git add src/services/ai.ts src/services/ai.test.ts
git commit -m "fix: suppress local-model thinking via chat_template_kwargs + strip non-bold analysis preambles"
```

---

### Task 2: Trimming that actually shortens

**Files:**
- Modify: `src/services/ai.ts:2598-2611` (`trimSectionToLimit`)
- Test: `src/services/ai.test.ts`

**Interfaces:**
- Consumes: `callLLM` (unchanged).
- Produces:
  - `export function countWords(text: string): number` — whitespace-delimited word count.
  - `export function bestTrimCandidate(input: string, candidates: string[], budgetWords: number): { text: string; withinBudget: boolean }` — picks the best trim result; never longer than `input`.
  - `trimSectionToLimit(sectionText, sectionTitle, budgetWords, settings)` signature unchanged; internally loops.

- [ ] **Step 1: Write failing tests for the pure helpers**

Add to `src/services/ai.test.ts` (add `countWords, bestTrimCandidate` to the `./ai` import):

```ts
describe('countWords', () => {
  it('counts whitespace-delimited words', () => {
    expect(countWords('one two   three\nfour')).toBe(4);
  });
  it('is 0 for empty/whitespace', () => {
    expect(countWords('   ')).toBe(0);
  });
});

describe('bestTrimCandidate', () => {
  const input = 'w '.repeat(100).trim(); // 100 words
  it('prefers the longest candidate that is within budget', () => {
    const under50 = 'w '.repeat(40).trim();
    const under80 = 'w '.repeat(70).trim();
    const r = bestTrimCandidate(input, [under50, under80], 80);
    expect(r.text).toBe(under80);
    expect(r.withinBudget).toBe(true);
  });
  it('falls back to the shortest candidate when none meet budget', () => {
    const c90 = 'w '.repeat(90).trim();
    const c95 = 'w '.repeat(95).trim();
    const r = bestTrimCandidate(input, [c95, c90], 80);
    expect(r.text).toBe(c90);
    expect(r.withinBudget).toBe(false);
  });
  it('never returns text longer than the input', () => {
    const grew = 'w '.repeat(150).trim();
    const r = bestTrimCandidate(input, [grew], 80);
    expect(r.text).toBe(input); // all candidates grew -> return input
    expect(r.withinBudget).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/ai.test.ts -t 'countWords|bestTrimCandidate'`
Expected: FAIL with "countWords is not a function" / "bestTrimCandidate is not a function".

- [ ] **Step 3: Implement the pure helpers**

Add just above `trimSectionToLimit` in `src/services/ai.ts`:

```ts
/** Whitespace-delimited word count. */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Choose the best trim result. Candidates that grew beyond the input are
 * discarded; among the rest, prefer the longest that fits the budget (most
 * content retained), else the shortest. If every candidate grew, return the
 * input unchanged — a "trim" must never make text longer.
 */
export function bestTrimCandidate(
  input: string,
  candidates: string[],
  budgetWords: number,
): { text: string; withinBudget: boolean } {
  const inputWords = countWords(input);
  const scored = candidates
    .map(text => ({ text, words: countWords(text) }))
    .filter(c => c.words > 0 && c.words <= inputWords);
  if (scored.length === 0) return { text: input, withinBudget: inputWords <= budgetWords };

  const underBudget = scored.filter(c => c.words <= budgetWords);
  if (underBudget.length > 0) {
    const best = underBudget.reduce((a, b) => (b.words > a.words ? b : a));
    return { text: best.text, withinBudget: true };
  }
  const shortest = scored.reduce((a, b) => (b.words < a.words ? b : a));
  return { text: shortest.text, withinBudget: false };
}
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run: `npx vitest run src/services/ai.test.ts -t 'countWords|bestTrimCandidate'`
Expected: all PASS.

- [ ] **Step 5: Rewrite `trimSectionToLimit` as a measure-and-retry loop**

Replace the body of `trimSectionToLimit` (`src/services/ai.ts:2599-2611`) with:

```ts
export async function trimSectionToLimit(sectionText: string, sectionTitle: string, budgetWords: number, settings: AISettings): Promise<string> {
  const baseSystem = `You condense grant/manuscript sections to fit strict page limits WITHOUT losing substance.
Rules:
- The result MUST be at most ${budgetWords} words and MUST be shorter than the input.
- Preserve every distinct claim, aim, number, and citation marker like [3]. Cut redundancy, filler, hedging, and over-explanation only.
- Keep the same heading-free plain prose and paragraph order.
- Do NOT use em dashes or en dashes. Keep sentences under 30 words.
- Example: "In order to be able to determine whether X occurs, we performed" -> "To test whether X occurs, we".
Return ONLY the condensed section text. No preamble, no commentary.${grantInstructionsBlock()}`;

  const candidates: string[] = [];
  let current = sectionText;
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = attempt === 0
      ? `Section "${sectionTitle}" (target: at most ${budgetWords} words):\n"""\n${sectionText}\n"""\n\nCondense it to fit the budget.`
      : `Your previous draft was ${countWords(current)} words — still too long. Cut it to under ${budgetWords} words by removing redundancy and filler only. Keep every distinct claim, number, and citation marker.\n"""\n${current}\n"""`;
    const out = (await callLLM(prompt, settings, baseSystem, false)).trim();
    if (!out) break;
    candidates.push(out);
    current = out;
    if (countWords(out) <= budgetWords) break; // good enough, stop early
  }

  return bestTrimCandidate(sectionText, candidates, budgetWords).text;
}
```

- [ ] **Step 6: Type-check, run unit tests, commit**

```bash
npm run lint && npx vitest run src/services/ai.test.ts
git add src/services/ai.ts src/services/ai.test.ts
git commit -m "fix: trimSectionToLimit measure-and-retry loop that never returns longer text"
```

---

### Task 3: Thread `stop` sequences through the LLM call path

**Files:**
- Modify: `src/services/ai.ts:1188-1197` (`LLMOptions`), `:1199-1204` (`callLLM` routing), `:638` (`callLocalLLM` signature), `:680-688` (local `baseBody`), `:1219-1231` (openai path)

**Interfaces:**
- Consumes: nothing new.
- Produces: `LLMOptions` gains `stop?: string[]`. `callLocalLLM` gains a trailing `stop?: string[]` param. When provided, it is sent as `stop` on the local body and as `stop` on the OpenAI-SDK path. Consumed by Task 4.

- [ ] **Step 1: Add `stop` to `LLMOptions`**

In `src/services/ai.ts:1188-1197`, add to the interface:

```ts
  /** Stop sequences to end generation early (local + openai paths). */
  stop?: string[];
```

- [ ] **Step 2: Pass `stop` from `callLLM` into the local and openai paths**

In `callLLM` (`src/services/ai.ts:1200`), extend the destructure and the local call:

```ts
  const { jsonSchema, temperature, stop } = opts;
  if (settings.provider === 'local') {
    return callLocalLLM(prompt, settings, systemPrompt, images, signal, maxTokens, jsonMode, jsonSchema, temperature, stop);
  } else if (settings.provider === 'anthropic') {
```

In the openai branch (the `openai.chat.completions.create({...})` call around `src/services/ai.ts:1222`), add `stop` to the request object right after the `max_tokens` spread:

```ts
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(stop && stop.length ? { stop } : {}),
```

- [ ] **Step 3: Accept and apply `stop` in `callLocalLLM`**

Change the `callLocalLLM` signature (`src/services/ai.ts:638`) to add a trailing param:

```ts
async function callLocalLLM(prompt: string, settings: AISettings, systemPrompt: string = "", images?: AttachedImage[], signal?: AbortSignal, maxTokens?: number, jsonMode: boolean = false, jsonSchema?: Record<string, any>, temperature?: number, stop?: string[]): Promise<string> {
```

Then add `stop` into `baseBody` (the object at `src/services/ai.ts:680`), after `chat_template_kwargs`:

```ts
    chat_template_kwargs: { enable_thinking: false },
    ...(stop && stop.length ? { stop } : {}),
```

- [ ] **Step 4: Type-check and commit**

```bash
npm run lint
git add src/services/ai.ts
git commit -m "feat: thread optional stop sequences through callLLM to local/openai"
```

---

### Task 4: Section-aware, short autocomplete

**Files:**
- Modify: `src/services/ai.ts:1274-1286` (`generateCompletion`), `src/extensions/AutoComplete.ts` (`onSuggest` type + heading lookup), `src/components/Editor.tsx:212-217` (forward heading)

**Interfaces:**
- Consumes: `callLLM` `stop` option (Task 3).
- Produces:
  - `generateCompletion(contextText: string, settings: AISettings, signal?: AbortSignal, heading?: string): Promise<string>`
  - `AutoCompleteOptions.onSuggest: (contextText: string, signal: AbortSignal, meta?: { heading?: string }) => Promise<string>`

- [ ] **Step 1: Make `generateCompletion` section-aware, short, and stop-bounded**

Replace `generateCompletion` (`src/services/ai.ts:1274-1286`) with:

```ts
export async function generateCompletion(contextText: string, settings: AISettings, signal?: AbortSignal, heading?: string): Promise<string> {
  const docKind = documentContext.mode === 'grant' ? 'grant application' : 'scientific manuscript';
  const system =
    `You are a ${docKind} autocomplete engine. ` +
    (heading ? `The author is writing the "${heading}" section. ` : '') +
    'The user sends you the text so far. Reply with ONLY the next 1-2 sentences that naturally continue it. ' +
    'Continue the author\'s thought forward — never restate, summarize, or re-explain what they already wrote. ' +
    'Start immediately with the next word (add a leading space if the text does not end with one). ' +
    'No preamble, no analysis, no labels, no reasoning, no quotes around your answer. ' +
    'Wrong: "Sure! The next sentence is: X." Wrong: "Thinking Process: 1. ..." Right: " X."';

  const raw = await callLLM(contextText, settings, system, false, undefined, signal, 80, {
    stop: ['\n\n', '\n#'],
  });
  return raw.trim();
}
```

- [ ] **Step 2: Extend `onSuggest` typing and compute the nearest heading in the extension**

In `src/extensions/AutoComplete.ts`, change the `onSuggest` field in `AutoCompleteOptions` to:

```ts
  /** Called with text before cursor + abort signal (+ section heading); resolves to the completion string */
  onSuggest: (contextText: string, signal: AbortSignal, meta?: { heading?: string }) => Promise<string>;
```

In `triggerCompletion`, after `const contextText = ...`, compute the nearest preceding heading by scanning backward through top-level nodes and pass it through. Replace the `onSuggest(contextText, abortCtrl.signal)` call with:

```ts
      let heading: string | undefined;
      view.state.doc.descendants((node: any, pos: number) => {
        if (pos < from && node.type.name === 'heading') heading = node.textContent || heading;
        return pos < from; // stop descending past the cursor
      });
      const suggestion = await options.onSuggest(contextText, abortCtrl.signal, { heading });
```

(The default `onSuggest` in `addOptions()` stays valid — the new `meta` param is optional.)

- [ ] **Step 3: Forward the heading from the Editor**

In `src/components/Editor.tsx`, replace the `onSuggest` callback (lines 214-217) to forward `meta.heading`:

```ts
        onSuggest: (contextText, signal, meta) => {
          if (!aiSettingsRef.current) return Promise.resolve('');
          return generateCompletion(contextText, aiSettingsRef.current, signal, meta?.heading);
        },
```

(`onLoadingChange: setAutocompleteLoading` on the next line is unchanged.)

- [ ] **Step 4: Type-check**

Run: `npm run lint`
Expected: passes with no errors.

- [ ] **Step 5: Manual smoke against the live model**

Start the dev server (`npm run dev`), point AI settings at `http://localhost:8080/v1/chat/completions` / model `ornith`, enable autocomplete, type two sentences of a paragraph, pause. Expect a ghost-text continuation that (a) moves the thought forward, (b) is 1-2 sentences, (c) contains no "Thinking Process"/"Sure!"/label text. Press Tab to accept.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai.ts src/extensions/AutoComplete.ts src/components/Editor.tsx
git commit -m "feat: section-aware, stop-bounded autocomplete (Copilot-style ghost text)"
```

---

### Task 5: Extend the eval harness with `eval:local` and new scorers

**Files:**
- Create: `scripts/eval/checks.ts`
- Modify: `scripts/eval/run.ts` (call checks + report), `package.json` (scripts)
- Test: `src/services/ai.test.ts` (unit-test the pure check predicates)

**Interfaces:**
- Consumes: `trimSectionToLimit`, `generateCompletion`, `countWords` (from `src/services/ai.ts`).
- Produces:
  - `export function looksLikeThinking(text: string): boolean` — true if text contains a thinking/preamble marker.
  - `export function isForwardContinuation(context: string, completion: string): boolean` — false if the completion merely repeats the context's last sentence or is empty.
  - `export async function runQualityChecks(settings: AISettings): Promise<void>` — runs trim + autocomplete + thinking-leak checks and prints pass/fail.

- [ ] **Step 1: Unit-test the pure predicates first**

Add to `src/services/ai.test.ts`. Import the predicates from the new module: `import { looksLikeThinking, isForwardContinuation } from '../../scripts/eval/checks';`

```ts
describe('eval predicates', () => {
  it('looksLikeThinking flags preambles', () => {
    expect(looksLikeThinking('Thinking Process: first I will...')).toBe(true);
    expect(looksLikeThinking('Sure! Here is the continuation.')).toBe(true);
    expect(looksLikeThinking(' and then the reaction proceeds.')).toBe(false);
  });
  it('isForwardContinuation rejects a verbatim restatement', () => {
    const ctx = 'The reaction proceeds at room temperature.';
    expect(isForwardContinuation(ctx, 'The reaction proceeds at room temperature.')).toBe(false);
    expect(isForwardContinuation(ctx, ' It then yields the product.')).toBe(true);
    expect(isForwardContinuation(ctx, '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/services/ai.test.ts -t 'eval predicates'`
Expected: FAIL — module `scripts/eval/checks` not found.

- [ ] **Step 3: Create `scripts/eval/checks.ts`**

```ts
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
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run src/services/ai.test.ts -t 'eval predicates'`
Expected: all PASS.

- [ ] **Step 5: Wire the checks into `run.ts`**

In `scripts/eval/run.ts`, add near the top import block:

```ts
import { runQualityChecks } from './checks';
```

At the end of `main()`, after the "On-target rate" console.log block (around line 90), add:

```ts
  if (process.env.EVAL_SKIP_CHECKS !== '1') {
    try { await runQualityChecks(settings); }
    catch (e) { console.log(`quality checks ERROR: ${e instanceof Error ? e.message : e}`); }
  }
```

- [ ] **Step 6: Add the `eval:local` npm script**

In `package.json` `scripts`, add (after `"test:watch"`):

```json
    "eval:local": "EVAL_PROVIDER=local EVAL_LOCAL_URL=http://localhost:8080/v1/chat/completions EVAL_LOCAL_MODEL=ornith npx tsx scripts/eval/run.ts"
```

Also update the harness header comment in `scripts/eval/run.ts` (the local example around lines 9-11) to show the `localhost:8080` / `ornith` invocation and mention `npm run eval:local`.

- [ ] **Step 7: Run the live harness end-to-end**

Run: `npm run eval:local`
Expected: agent recall table prints, then a "Quality checks" block with `trim PASS` and `autocomplete PASS`. If either FAILs, that is the baseline Task 6 tunes.

- [ ] **Step 8: Type-check and commit**

```bash
npm run lint && npx vitest run src/services/ai.test.ts
git add scripts/eval/checks.ts scripts/eval/run.ts package.json src/services/ai.test.ts
git commit -m "feat: eval:local harness with trim/autocomplete/thinking-leak scorers"
```

---

### Task 6: Empirical prompt-tuning pass

**Files:**
- Modify: agent prompt strings in `src/services/ai.ts` (analysis agents ~lines 30-300, find/fix prompts ~1427/1454, `trimSectionToLimit` system, `generateCompletion` system) — only as the measurements justify.
- Create: `docs/superpowers/plans/2026-07-04-eval-results.md` (before/after numbers).

**Interfaces:**
- Consumes: `npm run eval:local` (Task 5). Produces no new code interfaces — this is a measurement-driven tuning task.

- [ ] **Step 1: Record the baseline**

Run: `npm run eval:local` (with the live server up). Copy the full output into a new file `docs/superpowers/plans/2026-07-04-eval-results.md` under a "## Baseline" heading, including per-agent recall, on-target rate, and the trim/autocomplete PASS/FAIL lines.

- [ ] **Step 2: Tune the weakest signal, one change at a time**

Pick the single worst number from the baseline (lowest-recall agent, or a FAILing quality check). Make ONE prompt edit targeting it — e.g. sharpen an agent's role sentence, add a concrete example to the find prompt, or tighten the trim/autocomplete system prompt. Do not change more than one prompt per measurement.

- [ ] **Step 3: Re-measure and keep or revert**

Run: `npm run eval:local`. If the targeted number improved and nothing else regressed, keep the change and append the new numbers to the results doc under a dated "## Iteration N" heading. If it regressed, `git checkout -- src/services/ai.ts` for that hunk and try a different edit. Repeat Steps 2-3 for the next-worst signal until numbers plateau (typically 3-5 iterations).

- [ ] **Step 4: Guard against regressions in unit tests and types**

Run: `npm run lint && npm run test`
Expected: all pass (prompt edits should not affect these, but confirm).

- [ ] **Step 5: Commit the tuned prompts and results**

```bash
git add src/services/ai.ts docs/superpowers/plans/2026-07-04-eval-results.md
git commit -m "perf: tune agent/trim/autocomplete prompts against ornith-9b (see eval-results)"
```

---

## Final verification

- [ ] `npm run lint` — clean.
- [ ] `npm run test` — all Vitest suites pass.
- [ ] `npm run eval:local` — trim and autocomplete checks PASS; agent recall at or above baseline.
- [ ] Manual in-app smoke against `localhost:8080`: run a full review (no "Thinking Process" text in any suggestion), Trim an over-limit section (result is strictly shorter), Tab-autocomplete (relevant 1-2 sentence continuation, no leaked meta-text).
