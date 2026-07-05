# Small-Model AI Quality — Design

**Date:** 2026-07-04
**Branch:** feat/review-crew-overhaul
**Status:** Approved design, pending implementation plan

## Problem

The app's AI output is unreliable on small local models — specifically the
user's `ornith-9b-mtp-kl-Q4_K_M.gguf` served by llama.cpp (build `b9827`) at
`http://localhost:8080/v1/chat/completions`. Concrete failures reported:

1. **Review agents emit their thoughts** into the output, making suggestions
   worse.
2. **Trimming a section to a page limit produces *longer* text**, not shorter.
3. **Autocomplete is irrelevant** and leaks meta-text like "Thinking Process:
   1. Analyze the request…".
4. Prompts were never tuned against this model, so it does not do what is
   intended.

## Root cause (empirically verified against the live server)

`ornith-9b-mtp` is a **reasoning model that always emits a "Thinking Process"**
into the OpenAI-style `reasoning_content` field. Two probes established the
mechanism and the fix:

- With `max_tokens: 20`, the model spent **all** tokens on `reasoning_content`
  and returned an **empty `content`** (`finish_reason: "length"`). So thinking
  silently steals the output budget.
- The app currently sends top-level `enable_thinking: false` and `think: false`
  (ai.ts:686–687). **This build ignores them** — thinking still happens.
- Sending **`chat_template_kwargs: { enable_thinking: false }`** fully suppresses
  it: `reasoning_content` comes back `null` and `content` is a clean `"ok"`.

This single misconfiguration is the shared root cause of failures 1, 3, and part
of 2. Fixing it unblocks everything else and returns the full token budget to
real output.

## Scope

This sub-project ("Sub-project A" in the overhaul decomposition) covers AI /
prompt quality only. Editor, fonts, and the per-section page model are a
separate sub-project ("B") and are out of scope here.

Autocomplete scope (confirmed with user): **make the existing Tab-to-accept
ghost text reliable and relevant** — section-aware context, stop sequences,
tuned prompt. No word-by-word partial acceptance or multi-line FIM in this pass.

## Architecture

### A1 — Suppress thinking at the source (`src/services/ai.ts`)

The local request body (built around ai.ts:685) gains
`chat_template_kwargs: { enable_thinking: false }` alongside the existing
`enable_thinking`/`think` flags (kept for other backends that read them). This
is additive and harmless to servers that ignore unknown fields.

Belt-and-suspenders in `stripThinkingBlocks` (ai.ts:831+): in addition to the
existing `<think>…</think>` handling, strip a **leading bare thinking preamble**
— a block that starts with `Thinking Process:`, `Reasoning:`, or a
`1.  **…**`-style numbered analysis and precedes the real answer. This protects
against any backend that emits thinking as plain `content` text rather than in
`reasoning_content`, and against partial suppression.

Interface unchanged: `callLLM` still returns clean answer text; callers are
unaffected.

### A2 — Trimming that actually shortens (`src/services/ai.ts`)

`trimSectionToLimit(sectionText, sectionTitle, budgetWords, settings)` becomes a
**measure-and-retry loop** instead of a single call:

1. Call the model with a tightened prompt (concrete shorten instruction + one
   short before/after example; explicit "return ONLY the condensed prose").
2. Count words of the result. **Accept** if `words <= budgetWords`.
3. If still over budget **or longer than the input**, re-prompt telling the
   model its exact draft length and the hard target ("Your draft was N words.
   Cut it to under M words by removing redundancy and filler only. Keep every
   distinct claim, number, and citation marker."). Retry up to **2** times.
4. **Final guard:** never return text longer than the input. If all retries
   still exceed the input length, return the shortest candidate produced and let
   the caller surface a "could not reach the limit" note.

The function stays a pure `string -> Promise<string>` from the caller's view; the
loop is internal. A small exported pure helper `countWords(text)` is added for
reuse and unit testing.

Caller (`App.tsx` trim handler / `GrantPanel` Trim button) is unchanged except it
may show the "could not fully reach limit" note when returned text is still over
budget (already has a `trimmingSection` spinner state to hang this off).

### A3 — Empirical prompt tuning harness (`scripts/eval/`)

The existing harness (`scripts/eval/run.ts`) already scores the analysis agents
against a seeded-error fixture via a real LLM. Extend it:

- **npm script:** add `"eval:local"` to `package.json` that runs the harness
  pre-wired to `EVAL_PROVIDER=local`,
  `EVAL_LOCAL_URL=http://localhost:8080/v1/chat/completions`,
  `EVAL_LOCAL_MODEL=ornith` (overridable by env). Documented in the harness
  header.
- **Broaden scorers** beyond analysis-agent recall, added as separate check
  functions in a new `scripts/eval/checks.ts`:
  - **trim check:** run `trimSectionToLimit` on an over-budget fixture section;
    pass = output word count `<= budget` and `< input`.
  - **autocomplete check:** run `generateCompletion` on a fixture context; fail
    if the output contains a thinking/preamble marker (`Thinking Process`,
    `Sure!`, `Here is`, `As an AI`, leading numbered analysis) or merely repeats
    the prompt's last sentence; pass if it is a plausible forward continuation.
  - **thinking-leak check:** assert no agent/autocomplete output contains
    `reasoning_content`-style markers after A1.
- **Workflow:** for each prompt change, run `eval:local`, record before/after
  numbers, change one thing, re-run. Prompt edits land only when the numbers
  hold or improve. The final PR/commit message reports the before/after table.

No production code depends on the harness; it is a measurement tool run manually.

### A4 — Copilot-style autocomplete (`src/services/ai.ts`, `src/extensions/AutoComplete.ts`, `src/components/Editor.tsx`)

With thinking suppressed (A1), completions become usable. Tighten
`generateCompletion(contextText, settings, signal)`:

- **Section-aware context:** the caller (Editor autocomplete `onSuggest`) already
  has the doc; pass the current section heading (nearest preceding heading) plus
  the existing preceding-text window so the model continues *this* section's
  thought. Keep total context bounded (~800–1000 chars) for latency.
- **Stop sequences:** pass `stop` (e.g. `["\n\n", "\n#"]`) and a small
  `max_tokens` (~60–80) so completions stay to a crisp 1–2 sentences and return
  fast. `callLLM` gains an optional `stop?: string[]` passthrough.
- **Prompt:** tuned via the A3 autocomplete check to produce a forward
  continuation, never a restatement, label, or analysis.

The extension's trigger/debounce/ghost-text/Tab-accept mechanics
(`AutoComplete.ts`) are unchanged — only the suggestion *content* quality
improves.

## Data flow (unchanged shape, better output)

```
callLLM(local) ──[+chat_template_kwargs.enable_thinking:false]──▶ clean content
      │
      ├─▶ analyze agents ──▶ suggestions (no thinking leak)
      ├─▶ trimSectionToLimit ──[measure/retry loop]──▶ text ≤ budget
      └─▶ generateCompletion ──[section ctx + stops]──▶ ghost text
```

## Testing

- **Type-check gate:** `npm run lint` (tsc).
- **Unit (vitest):** `countWords`; the trim loop's "never longer than input"
  guard via a mocked `callLLM` that returns a too-long string, asserting the
  guard trims/falls back; `stripThinkingBlocks` gains cases for a bare
  `Thinking Process:` preamble and a leading numbered-analysis block.
- **Live eval (manual):** `npm run eval:local` before and after each prompt
  change; the before/after numbers are the acceptance evidence for A2–A4.
- **Manual smoke:** in the app pointed at `localhost:8080`, run a review (no
  thoughts in suggestions), Trim an over-budget section (result is shorter),
  and use Tab autocomplete (relevant continuation, no "Thinking Process").

## Out of scope (this sub-project)

- Word-by-word / multi-line autocomplete acceptance (deferred).
- Editor, font control, per-section page model (Sub-project B).
- Changing provider routing for cloud models (fixes are local-model-focused but
  the thinking-strip hardening also helps cloud reasoning models).

## Files touched

- `src/services/ai.ts` — `chat_template_kwargs` on local body; harden
  `stripThinkingBlocks`; `trimSectionToLimit` retry loop + `countWords` export;
  `generateCompletion` section context + `stop`/`max_tokens`; `callLLM` optional
  `stop` param.
- `src/extensions/AutoComplete.ts` / `src/components/Editor.tsx` — pass section
  heading into `onSuggest` context.
- `scripts/eval/run.ts`, `scripts/eval/checks.ts` (new), `package.json` —
  `eval:local` script and broadened scorers.
- `src/services/ai.test.ts` — `countWords`, trim guard, thinking-strip cases.
