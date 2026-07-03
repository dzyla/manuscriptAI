# Grant Mode + Suggestion Robustness — Design

Date: 2026-07-03
Status: approved-by-default (user AFK; recommended options chosen, noted below)

## Goals

1. Make the suggestion/rewrite pipeline robust: suggestions must survive LLM misquoting and apply reliably in the editor, especially with small local models.
2. Add a grant-writing mode: NIH templates (R01, R21, R03, plus a custom skeleton), per-document funder instructions that all agents follow, and grant-specific agent personas.
3. Harden prompts for small LLMs.
4. QoL: per-section page/word budgets in grant mode, salvage-stats feedback, safer accept-all.

## Assumptions (user was away; recommended options selected)

- Templates: NIH core research set (R01, R21, R03) + a generic/custom grant skeleton. Fellowships/K-awards can be added later using the same template shape.
- Grant mode is a per-document mode toggle (`manuscript` | `grant`), not a separate workspace.
- Grant instructions are stored per document (Dexie `DocumentRow.grantInstructions`), edited via a modal, injected into every LLM prompt while in grant mode.
- All phases implemented this session, robustness first.

## Part 1 — Suggestion robustness

### Root causes (verified in code)

- `ai.ts` anchors suggestions with `text.indexOf(originalText)` then drops non-matches silently (`filter(startIndex !== -1)`). Small models misquote punctuation/whitespace/citation markers, so most suggestions are discarded before reaching the UI.
- Three divergent plain-text representations: `App.stripHtml` (whitespace-collapsed), TipTap `doc.textContent` (no block separators), raw HTML. Anchors computed against one fail against the others.
- `Editor.findTextPosition` is exact-match only; the raw-HTML `content.replace` fallback almost never matches.
- `applySuggestion` applies the edit inside a 200 ms `setTimeout`, but `handleAcceptSuggestion` reads `getHTML()` immediately, so history items record stale content, and accept-all races.

### Design

**New module `src/utils/textMatch.ts`** — single source of truth for locating quoted text:

- `normalizeForMatch(s)`: map curly quotes → straight, en/em dashes → `-`, NBSP/thin spaces → space, collapse whitespace runs; returns normalized string + offset map back to the original.
- `findTextSpan(haystack, needle): { start, end, matchedText, method } | null` with a tiered strategy:
  1. exact `indexOf`;
  2. normalized `indexOf` (both sides normalized, span mapped back through the offset map);
  3. anchor fuzzy match: locate normalized 20-char prefix and suffix of the needle; if both found within a plausible window (needle length ±30%), accept the spanned region when its Levenshtein similarity to the needle is ≥ 0.75.
- `flattenDoc(pmDoc)`: walks ProseMirror text nodes producing a flat string with `\n\n` block separators and a char→PM-position segment map, so any span in the flat string maps to `{from, to}`.

**`anchorSuggestions()` in `ai.ts`**: shared helper replacing all four copies of the map/filter logic (local chunks, cloud path, repair path, chat suggestions). For each raw suggestion it:
- locates the quote with `findTextSpan` against the canonical document text;
- **rewrites `originalText` to the matched document text** so accept-time exact matching always succeeds;
- drops no-ops (`originalText === suggestedText` after trim) and unlocatable quotes;
- returns `{ suggestions, salvaged, dropped }` so the UI can report fuzzy-recovered counts.

**Canonical text**: `Editor` exposes `getPlainText()` built from `flattenDoc(editor.state.doc)`. `App` uses it (falling back to `stripHtml` only before editor mount) for analysis, chat context, and rewrites, so LLM input, anchors, and editor content are the same string.

**Editor apply path**: `findTextPosition` delegates to `flattenDoc` + `findTextSpan` (fuzzy fallback included). `applySuggestion` applies the replacement synchronously and returns the new HTML; the scroll/flash animation stays but no longer gates the edit. `handleAcceptSuggestion` records correct before/after content. Accept-all sorts by `startIndex` descending (later edits first) so earlier anchors stay valid, and re-anchors each suggestion at apply time.

## Part 2 — Prompt hardening for small LLMs

- Add `COMPACT_AGENT_PROMPTS` (one short, complete prompt per agent) used for chunked local mode instead of `activePrompt.substring(0, 400)` which cuts mid-sentence and loses all rules.
- All JSON-suggestion prompts gain an explicit quoting rule: copy `originalText` exactly, including punctuation, capitalization, and citation markers like `[3]`; never paraphrase inside `originalText`.
- Local OpenAI-compatible calls send `response_format: {type: "json_object"}` when JSON is expected; on HTTP 400 the same endpoint is retried once without it (some servers reject unknown params).
- Anthropic analysis calls raise `max_tokens` to 8192 (4096 truncates 8–15-suggestion JSON payloads → parse failures).
- Chunked mode asks for 3–5 suggestions per chunk (matches small-model reliability).

## Part 3 — Grant mode

### Data model

- `types.ts`: `export type DocumentMode = 'manuscript' | 'grant'`. `DocumentRow` gains `mode`, `grantInstructions?`, `grantTemplateId?`. `useDocumentStore` gains the fields, setters, persistence (defaults keep existing docs in `manuscript` mode).

### Templates — `src/services/grantTemplates.ts`

```ts
interface GrantTemplateSection { title: string; pageLimit?: number; guidance: string; }
interface GrantTemplate { id: string; name: string; mechanism: string; description: string; sections: GrantTemplateSection[]; }
```

Templates: **NIH R01** (Specific Aims 1 p; Research Strategy 12 p: Significance, Innovation, Approach; plus Project Summary/Narrative), **NIH R21** (Aims 1 p; Strategy 6 p), **NIH R03** (Aims 1 p; Strategy 6 p), **Custom Grant** (generic skeleton: Summary, Aims, Background, Approach, Timeline). `templateToHtml(t)` renders H2 per section with an italic guidance paragraph the author overwrites. Page budgets assume ~500 words/page.

### Grant agent personas

`GRANT_AGENT_PROMPTS` in `ai.ts`, same schema/rules block as manuscript prompts:

- `manager` → **Grant Architect**: Specific Aims page logic (hook, gap, critical need, long-term goal, objective, central hypothesis, aims independence, payoff paragraph), section completeness vs. mechanism.
- `editor` → **Language Surgeon (grant register)**: same sentence surgery, plus grant conventions (present/future tense for proposed work, "we will", no unexplained jargon for a broad study section).
- `reviewer-2` → **Study Section Reviewer**: NIH review criteria (Significance, Innovation, Approach, Investigator, Environment; overall impact); flags weak premise, missing rigor/reproducibility, absent alternatives/pitfalls, dependent aims.
- `researcher` → **Impact & Feasibility**: buried payoffs, unsupported feasibility claims, missing preliminary-data links, vague deliverables.
- `citation-checker`: unchanged prompt, grant-aware preamble.

Prompt resolution: `resolveAgentPrompt(agent, settings, mode, grantInstructions)` — precedence: user custom prompt > mode prompt set; then append a `FUNDER INSTRUCTIONS (must follow)` block when instructions are non-empty. Wired through `analyzeText`, `chatWithAgent`, `rewriteSection`, `transformWithInstruction`, `manuscriptSummary` (grant mode gets a mock study-section review variant), and autocomplete's system prompt.

### UI

- Header: mode toggle (Manuscript / Grant). Switching modes only changes prompts/UI affordances, never content.
- "New from template" action (grant mode): modal listing templates with mechanism/page info; imprints skeleton, with an overwrite confirmation when the document is non-empty.
- "Grant instructions" button (grant mode): modal textarea persisted per document.
- Per-section budget strip (grant mode): live word count per H2 vs. template page budget (~500 words/page), green/amber/red.

## Part 4 — QoL

- Analysis toast reports salvage stats ("12 suggestions · 4 recovered by fuzzy match").
- Accept-all applies bottom-up and reports failures individually.
- Stale suggestions (unlocatable at accept time) surface as a distinct toast rather than silently failing.

## Error handling & testing

- No test runner exists; `npm run lint` (tsc) is the gate, plus `npm run build`. `textMatch.ts` is written as pure functions so a test runner can be added later.
- All new LLM behavior degrades gracefully: missing grant instructions → empty block; unknown mode → manuscript prompts; fuzzy match failure → suggestion dropped with count surfaced.

## Out of scope

- Multi-document management (Dexie still stores a single `current` document).
- Fellowship/K templates (same template shape, add later).
- Streaming responses.
