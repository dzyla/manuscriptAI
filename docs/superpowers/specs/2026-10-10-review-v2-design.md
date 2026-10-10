# Review v2: a checklist-driven review crew — design

Status: approved in conversation 2026-10-10, awaiting written-spec review.
Branch: `feat/review-v2`. Supersedes the review parts of the July 2026 crew overhaul
(`2026-07-05-advisory-suggestions-design.md`, find-then-fix in `2026-07-04-small-model-ai-quality-design.md`).

## Goal

Make the AI review of a grant or manuscript worth reading. The author's four complaints, all confirmed by a
read-only audit of `main` at `7b4df49`:

| Complaint | What causes it today |
|---|---|
| Shallow / generic | `manager` (the only agent that checks aims logic) and `consistency` are off for grants (`useAnalysis.ts:104`); nothing compares the Aims page with the Approach; grant prompts use pre-2025 criteria; the statistician has no grant prompt; SABV, key-resource authentication, power, timeline are never asked for; the local chunker collapses whitespace (`ai.ts:1180`) so chunks are whole sections or a lone heading |
| Too much noise | re-runs append duplicates (`useAIStore.ts:78`); agents overlap (reviewer-2 repeats statistician, consistency, citation-checker); quotas conflict (4-6 in the system prompt, 8-15 in the user prompt); containment dedupe hides specific flags; the citation detector misses `[1,4]` |
| Bad edits | highlight, locate and accept all use the first textual match; accepting a span that holds a citation flattens it to text; grant fixes use the manuscript rules; the Clarity & Impact agent strips hedges and pushes toward overclaiming |
| Hard to act on | the study-section review arrives as chat markdown, behind a "Summary & Gaps" button, with no scores, no links to the text, no Stop; filters are severity-only |

Behind all four: the eval (`scripts/eval`) is one 250-word IMRAD fixture whose recall is saturated (18/18) and
which measures neither grants nor precision, so no prompt change can be shown to help.

PDF output and the document-engine program (A2b-A5) are out of scope here; Word stays the last step.

## Non-goals

- Tracked changes, AI edits as revisions (sub-project B of the engine program).
- Reading biosketches, budgets or other attachments; Factor 3 is judged from the text only and says so.
- Any server component. Everything stays client-side; providers unchanged (`gemini`, `openai`, `anthropic`, `local`).
- Grant workspace features (drafting wizard, FOA-to-template, literature search).

## 1. The checklist

`src/services/review/checklist.ts` — plain data, no prompt prose.

```ts
type ReviewerRole = 'manager' | 'reviewer-2' | 'statistician' | 'researcher' | 'consistency';
type SectionKind =
  | 'summary' | 'narrative' | 'aims' | 'significance' | 'innovation' | 'approach' | 'strategy'   // grant
  | 'abstract' | 'introduction' | 'methods' | 'results' | 'discussion'                             // manuscript
  | 'references'                                                                                  // bibliography: never reviewed
  | 'any';
type FactorGroup = 1 | 2 | 3 | 'presentation';

interface ReviewCheck {
  id: string;                 // stable, kebab-case, prefixed by role and doc type
  doc: 'grant' | 'manuscript';
  factor?: FactorGroup;       // required when doc === 'grant'
  owner: ReviewerRole;        // exactly one
  sections: SectionKind[];    // where the evidence should be; 'any' = whole document
  scope: 'section' | 'cross'; // cross = needs facts from more than one section
  name: string;               // short label shown on the card, e.g. "Power for the proposed work"
  question: string;           // what the reviewer asks
  passes: string;             // what counts as adequate, so the model knows when NOT to flag
  severity: 'critical' | 'major' | 'minor';
}
```

Roles reuse existing `AgentType` ids so saved settings, `customPrompts` and highlight colours keep working.
Display names change with the document type:

| id | Grant name | Manuscript name |
|---|---|---|
| `manager` | Aims & Logic | Structure & Logic |
| `reviewer-2` | Importance | Importance & Claims |
| `statistician` | Rigor | Statistics & Rigor |
| `researcher` | Feasibility | Methods & Reproducibility |
| `consistency` | Consistency | Consistency |

`editor` belongs only to the edit pass (§4). `literature-reviewer`, `citation-checker` and `manuscript-ai` are
untouched by this work.

### 1.1 Grant checks (initial set)

Factor 1 = Importance of the Research, Factor 2 = Rigor and Feasibility, Factor 3 = Expertise and Resources
(NIH Simplified Peer Review Framework, due dates on or after 2025-01-25). `presentation` collects consistency
issues that belong to no factor; the summary statement shows them as "Additional comments".

| id | owner | factor | sections | scope | severity |
|---|---|---|---|---|---|
| `g-imp-gap` — knowledge gap stated explicitly | reviewer-2 | 1 | aims, significance | section | major |
| `g-imp-why` — why closing the gap matters, beyond "gap filling" | reviewer-2 | 1 | aims, significance | section | major |
| `g-imp-premise` — prior work the project rests on is cited, its strength and limits acknowledged | reviewer-2 | 1 | significance | section | major |
| `g-imp-innovation` — innovation is new to the field, not only to the lab | reviewer-2 | 1 | innovation | section | major |
| `g-imp-payoff` — expected outcomes and their impact are stated | reviewer-2 | 1 | aims, significance | section | minor |
| `g-log-objective` — long-term goal and the objective of this application stated | manager | 1 | aims | section | minor |
| `g-log-hypothesis` — central hypothesis stated and testable | manager | 2 | aims | section | critical |
| `g-log-independent` — aims are not interdependent | manager | 2 | aims, approach | cross | critical |
| `g-log-aims-approach` — every aim on the Aims page has an Approach part of the same scope, and no extra aims | manager | 2 | aims, approach | cross | critical |
| `g-log-measurable` — each aim has a measurable endpoint | manager | 2 | aims, approach | section | major |
| `g-log-scope` — the work fits the project period and is not overambitious | manager | 2 | aims, approach | cross | critical |
| `g-rig-design` — design per aim: controls, comparison groups | statistician | 2 | approach | section | major |
| `g-rig-power` — sample sizes justified by power analysis or precedent for the proposed experiments | statistician | 2 | approach | section | critical |
| `g-rig-stats` — analysis plan names the tests or models per aim | statistician | 2 | approach | section | major |
| `g-rig-sabv` — sex as a biological variable addressed for vertebrate animal and human studies, or exclusion justified | statistician | 2 | approach | section | major |
| `g-rig-bias` — randomization and blinding where applicable | statistician | 2 | approach | section | major |
| `g-rig-replication` — independent replication or validation | statistician | 2 | approach | section | minor |
| `g-rig-resources` — key biological and chemical resources authenticated, or the authentication plan referenced | statistician | 2 | approach | section | minor |
| `g-fea-prelim` — each aim supported by preliminary data or a cited track record | researcher | 2 | approach, significance | section | critical |
| `g-fea-pitfalls` — potential problems and alternative strategies per aim | researcher | 2 | approach | section | major |
| `g-fea-outcomes` — states what results would support or refute the hypothesis | researcher | 2 | approach | section | major |
| `g-fea-timeline` — timeline or milestones present and consistent with the aims | researcher | 2 | approach | cross | major |
| `g-exp-expertise` — the text shows expertise for each key method, or names the collaborator who has it | researcher | 3 | approach | section | major |
| `g-exp-resources` — required equipment, cohorts or access are available | researcher | 3 | approach | section | minor |
| `g-con-numbers` — numbers (n, doses, durations) agree across sections | consistency | presentation | any | cross | major |
| `g-con-terms` — entities named consistently; abbreviations defined at first use | consistency | presentation | any | cross | minor |
| `g-con-summary` — Project Summary matches the aims | consistency | presentation | summary, aims | cross | major |
| `g-con-uncited` — factual claims carry a citation | consistency | presentation | significance, innovation | section | minor |

Each row carries `name`, `question` and `passes` text in the file; the table abbreviates `question`. `passes`
must make the non-flag case concrete, e.g. for `g-rig-sabv`: "Adequate when the text states that both sexes are
studied, or justifies a single sex, or the work uses no vertebrate animals or human subjects."

### 1.2 Manuscript checks (initial set)

| id | owner | sections | scope | severity |
|---|---|---|---|---|
| `m-imp-question` — research question and gap clear | reviewer-2 | introduction | section | major |
| `m-imp-novelty` — advance over prior work stated and accurate | reviewer-2 | introduction, discussion | section | major |
| `m-imp-overclaim` — conclusions supported by the data; no causal language from correlational data | reviewer-2 | abstract, results, discussion | cross | critical |
| `m-log-structure` — each section does its job (results report, discussion interprets) | manager | any | section | minor |
| `m-log-flow` — results answer the stated question, in order | manager | introduction, results | cross | major |
| `m-log-abstract` — abstract matches the results | manager | abstract, results | cross | major |
| `m-rig-tests` — tests named and appropriate | statistician | methods, results | section | critical |
| `m-rig-n` — n reported and what n counts | statistician | introduction, methods, results | section | major |
| `m-rig-variability` — SD/SEM/CI specified | statistician | results | section | major |
| `m-rig-effect` — effect sizes reported alongside p-values | statistician | results | section | minor |
| `m-rig-multiple` — multiple comparisons handled | statistician | methods, results | section | major |
| `m-rig-controls` — appropriate controls | statistician | methods, results | section | major |
| `m-met-reproducible` — enough detail to replicate | researcher | methods | section | major |
| `m-met-materials` — sources, catalogue numbers or RRIDs given | researcher | methods | section | minor |
| `m-met-limitations` — limitations discussed | researcher | discussion | section | major |
| `m-met-data` — data and code availability stated | researcher | any | section | minor |
| `m-con-numbers` — numbers agree across sections | consistency | any | cross | major |
| `m-con-terms` — terms and abbreviations consistent | consistency | any | cross | minor |
| `m-con-figures` — every figure and table is referenced and described consistently | consistency | results | cross | minor |
| `m-con-uncited` — factual claims carry a citation | consistency | introduction, results, discussion | section | minor |

Manuscript checks have no factor; the summary groups them by severity (critical and major → Major concerns).

Three manuscript checks look in one more section than the table above first listed, so that problems where
authors actually put them are in scope: `m-imp-overclaim` also reads `results`, `m-rig-n` also reads
`introduction`, and `m-con-uncited` also reads `results`.

### 1.3 Invariants (unit-tested)

Ids unique; id prefix matches `doc` and owner; every role owns at least one check per `doc`; every grant check has
a `factor`; every manuscript check has none; every check's `sections` is non-empty and uses kinds of its `doc`
(or `any`); every `passes` is non-empty.

## 2. Findings and anchors

```ts
interface FindingAnchor {
  sectionKey: string;   // see §3.1
  quote: string | null; // null = missing-content finding, anchored to the section heading
  occurrence: number;   // which match of `quote` inside the section, 0-based
}

interface Finding {
  id: string;
  runId: string;
  checkId: string;
  agent: ReviewerRole | 'detector';
  anchor: FindingAnchor;
  issue: string;
  recommendation: string;
  severity: 'critical' | 'major' | 'minor';
  verification: 'verified' | 'unverified';   // 'unverified' when the verify step failed or was skipped
  status: 'open' | 'dismissed' | 'noted';    // 'noted' = the author inserted it as a note
}
```

Review findings never carry replacement text. Edits (§4) keep the existing `Suggestion` type, gain an `anchor`, and
lose their reliance on `startIndex`/`endIndex` for anything but sorting.

**One resolver.** `resolveAnchor(doc, anchor) → { from, to } | { heading: { from, to } } | null`
(`src/services/review/anchor.ts`) finds the section by `sectionKey` in the current document, then the
`occurrence`-th match of `quote` inside it using the existing `findTextSpan` normalisation. Missing-content
findings resolve to the heading. Highlight decorations, Locate, Insert note and Accept all call it; nothing else
searches the document. If the section key no longer resolves (heading renamed or deleted), the resolver searches
the whole document once and the card shows "moved"; if the quote is gone the card shows "text changed" and offers
Dismiss only.

**Dedupe and dismissal.** `fingerprint(f) = checkId + '|' + sectionKey + '|' + normalise(quote ?? '')`.
Within a run, findings with equal fingerprints merge; findings of the same `checkId` with overlapping spans merge
(the longer recommendation wins). Containment across *different* checks no longer suppresses anything. A dismissed
fingerprint is stored per document; later runs drop matching findings before display.

**Re-runs.** Starting a review replaces every `open` finding of the previous review run; `noted` and
dismissed fingerprints persist. Edits from Copy-edit are replaced only by the next Copy-edit run.

**Persistence.** Dexie v7 adds `reviewRuns` (`id, documentId, kind, startedAt`: run metadata, tier, model, call
count, per-role failures, the summary statement) and `findings` (`id, runId, documentId, status`), plus a
`reviewDismissals: string[]` field (fingerprints) on the `documents` row. No editor schema change, so the golden hashes
in `src/docx/preserve/hash.test.ts` are unaffected. Existing `suggestions` rows of kind `advisory` from old runs
are left alone and shown as legacy until dismissed.

## 3. The review pass

`src/services/review/` holds the engine; `useAnalysis.ts` calls it. `ai.ts` keeps `callLLM`, JSON repair and
provider routing; review prompt text moves out of it.

### 3.1 Section map

`sectionMap(doc: PMNode, docType) → Section[]` (pure). Walks heading nodes at every level:

```ts
interface Section { key: string; kind: SectionKind; title: string; level: number; from: number; to: number; text: string; headingFrom: number; headingTo: number; }
```

- Kind comes from a keyword table on the heading text ("Specific Aims" → `aims`; "Research Strategy" →
  `strategy`; "Significance", "Innovation", "Approach"; "Project Summary"/"Abstract"; "Project Narrative";
  IMRAD names; "Materials and Methods", "Background" → `introduction`, etc.).
- A heading the table does not know inherits its parent's kind ("Aim 1", "Preliminary Data", "Rigor",
  "Expected Outcomes" under Approach → `approach`). A top-level unknown heading is `any`.
- "References", "References Cited", "Bibliography", "Literature Cited" and "Works Cited" are `references`: no check
  targets them and their text is never sent to a reviewer.
- A specific parent kind always wins over a child's own keyword (a "Summary" subheading under Approach stays
  `approach`); under `strategy` or `any` the child's keyword decides.
- A preamble section (`key: 'preamble'`, kind `any`) is created only when there is text before the first heading.
- `key` = the heading path, normalised and joined with `/`, plus `#n` when siblings share a title:
  `approach/aim-2-rationale#0`. It is text-based on purpose: it survives edits elsewhere.
- No headings → one section `{ key: 'document', kind: 'any' }`.
- Text inside a section is built from the ProseMirror paragraphs, keeping paragraph breaks (the HTML regex
  chunker and its whitespace collapse are removed).

The grant template gains `projectYears?: number` (R01 5, R21 2, R03 2; unset for F31 and custom templates, whose periods vary)
for `g-log-scope` and `g-fea-timeline`; when absent the prompt says the period is unknown.

A `strategy` section (a single "Research Strategy" with no Significance / Innovation / Approach subheadings, as in
the F31 template) counts as all three kinds when checks are selected, so no check goes unasked.

### 3.2 Prompt rendering

`renderRolePrompt(role, ctx)` builds, in order:

1. **Preamble**: who the reviewer is and the document type. For grants it states the mechanism (from the grant
   template, when known), the project period, and the 2025 framework in two sentences. `customPrompts[role]`
   replaces this preamble only.
2. **Funder instructions** (existing `grantInstructions`, capped at 4,000 chars, as now).
3. **Checks** (derived from the role and the sections through `applicableChecks`), numbered: `[g-rig-power] Power for the proposed work — <question>. Adequate when: <passes>.`
   Only checks whose `sections` include a kind present in the input (or `any`).
4. **Rules**: report only checks that fail; report nothing for checks that pass; at most one finding per check
   per section unless the issues are distinct; quote the text exactly, or use `quote: ""` when something is
   missing (the mapper turns it into null); never write replacement text; never invent data, numbers or citations.
5. **Output schema**, passed as constrained decoding where the provider supports it (`json_schema` /
   `responseJsonSchema`), with `checkId` and `sectionKey` as **enums** of the ids and keys actually in play. Sections with an empty body
   and `references` sections are not offered as `sectionKey`s (a role with no anchor to offer is not run), and the
   schema objects carry `additionalProperties: false`:

```json
{ "findings": [ { "checkId": "...", "sectionKey": "...", "quote": "... or \"\" when missing", "issue": "...", "recommendation": "...", "severity": "critical|major|minor" } ] }
```

On the wire "quote" is always a string, because not every provider's constrained decoding accepts a nullable type; "" means a missing-content finding and the mapper turns it into quote: null.

No counts or quotas anywhere. A unit test asserts every check id appears in exactly one role's rendered prompt
for a document containing every section kind.

### 3.3 Cloud tier (about 7 calls)

1. Five role calls in parallel. Input: the whole document with section markers
   (`=== [approach] approach/aim-2#0 — Aim 2 ===`), the role's checks.
2. Map and validate: unknown `checkId`/`sectionKey` dropped (counted), quotes resolved with `resolveAnchor`,
   unresolvable quotes dropped (counted), dedupe (§2).
3. Merge deterministic detector findings (§3.6).
4. **Verify** (one call): the whole document plus the findings list (`id, checkId, sectionKey, quote, issue`).
   The model returns `{ keep: string[], drop: [{ id, reason }] }`, dropping findings the text already answers
   anywhere in the document. Missing ids are kept. On failure every finding is kept as `unverified`.
5. **Summary statement** (one call, §5).

### 3.4 Local tier (about 25-35 calls for an R01)

1. **Fact sheet**: one call per section (long sections split at paragraph boundaries under
   `localChunkSize`), schema:
   ```json
   { "aims": [{ "label": "Aim 1", "title": "...", "hypothesis": "..." }],
     "sampleSizes": [{ "what": "...", "n": "..." }], "models": ["..."], "methods": ["..."],
     "timeline": { "years": null, "milestones": ["..."] }, "prelimClaims": [{ "aim": "Aim 1", "claim": "..." }],
     "statsMentioned": ["..."], "abbreviations": [{ "short": "...", "long": "..." }] }
   ```
   Each item is tagged with its `sectionKey` during the merge, which is deterministic (concatenate, dedupe by
   normalised text). The merged sheet is capped at ~1,500 tokens by dropping `methods`, then `models`.
2. **Section checks**: for each section (or piece), one call per role that has `scope: 'section'` checks for
   that section's kind. Input: the section text, the fact sheet, the role's applicable checks.
3. **Cross checks**: one call per role that has `scope: 'cross'` checks. Input: the fact sheet and the section
   titles, not the text. Quotes in cross findings are optional; a cross finding without a resolvable quote
   anchors to the first section in its check's `sections` that exists.
4. **Verify missing-content findings** only, one batched call against the fact sheet; quote-bearing findings were
   produced from the text they quote and are not re-verified locally.
5. `recallPass` (existing setting, default on) repeats step 2 for the `critical` checks only.
6. **Summary statement** from the findings and the fact sheet (no full text).

`pipelineMode` (`find-fix` / `single`) no longer applies to the review pass; it is removed from the settings UI
when R4 deletes the old pipeline.

### 3.5 Cancellation, progress, failures

Every call takes the run's `AbortSignal`. Progress reports `{ role, section?, done, total }` ("Rigor · Approach
3/8"). A role whose calls all fail is recorded in `reviewRuns.failures` and shown in the summary card as
"Rigor review failed · Retry", which re-runs that role alone into the same run. Partial results from a role whose
calls partly failed are kept and the failure is noted. Stop aborts everything in flight; findings already mapped
are kept and the run is marked `stopped`.

### 3.6 Detectors

`detectors.ts` stays deterministic and each detector maps to a check id: N-mismatch → `*-con-numbers`,
abbreviation-before-definition → `*-con-terms`, uncited claim → `*-con-uncited`, the statistics detectors →
`m-rig-tests` / `m-rig-variability` / `m-rig-n` (manuscript only). The uncited-claim regex learns grouped and
ranged citations (`[1,4]`, `[2-5]`, `[1, 3-6]`) and treats a `citation` node in the flattened text as a
citation. A detector finding and an LLM finding with the same fingerprint merge; the LLM's recommendation wins.

## 4. The edit pass (Copy-edit)

A separate action. It never runs as part of Review.

- `editor` role, one call per section on local, one whole-document call with section markers on cloud.
- Prompt: the section kind and document type; the **house style** (below); the author's voice profile summary
  from the style audit (`activeSummary(settings.voiceProfile)`) when one exists; "keep hedges that reflect real
  uncertainty; do not strengthen claims". The Clarity & Impact agent's hedge-stripping instruction is deleted.
- Output: `{ edits: [{ sectionKey, quote, replacement, reason, severity }] }`. Each edit spans at most one
  sentence or clause and at most `MAX_REWRITE_WORDS` (80) words.
- **Guard**: every edit goes through `checkRewriteDetailed(quote, replacement)` from
  `src/services/proseAudit/rewrite.ts`. An edit that changes citations, numbers or markers is discarded and
  counted, never shown.
- **Apply**: Accept resolves the anchor, then applies through the same citation-safe span replacement the style
  rewrite uses (`replaceFlatSentence` in `StyleHighlights`), as one undoable transaction. The `content.replace`
  HTML fallback in `useSuggestionActions.ts` is removed. Accept-all applies edits from last to first.
- No quotas: edits are ranked by severity, then document order, and each section shows its top 5 with
  "Show more".

**House style.** `AISettings.houseStyle: { rules: string; noDashes: boolean }`, editable in Settings (AI) and from the Copy-edit menu. It
defaults to today's `SCIENTIFIC_WRITING_RULES` / `GRANT_WRITING_RULES` text (dash ban, sentence-length caps,
banned openers). The dash rule is the `noDashes` switch (default on), which both adds the rule to the prompt and turns
on `lintSuggestedText`'s dash stripping; the rest is free text. It is sent only to Copy-edit and "Draft a fix",
never to reviewers.

## 5. The summary statement and the Review panel

### 5.1 Summary statement

One call after verification. Input: verified (and unverified) open findings with ids, the section titles, the
aims (from the text on cloud, from the fact sheet on local). Output, validated:

```ts
type SummaryStatement =
  | { doc: 'grant'; overall: { score: number; text: string };
      factors: [
        { factor: 1; score: number; strengths: string[]; weaknesses: { text: string; findingIds: string[] }[] },
        { factor: 2; score: number; strengths: string[]; weaknesses: { text: string; findingIds: string[] }[] },
        { factor: 3; rating: 'sufficient' | 'insufficient'; text: string; findingIds: string[] },
      ];
      additional: { text: string; findingIds: string[] }[] }
  | { doc: 'manuscript'; recommendation: 'accept' | 'minor' | 'major' | 'reject'; summary: string;
      major: { text: string; findingIds: string[] }[]; minor: { text: string; findingIds: string[] }[] };
```

Scores are integers 1-9 (1 best), clamped; `findingIds` that do not exist are stripped. Strengths are allowed
without findings (the model reads the text for them on cloud; on local they come from the fact sheet and may be
empty). If the call fails the panel shows the findings list without a summary and a Retry.

The three-persona study section (`runStudySectionPanel`, `STUDY_SECTION_REVIEW_PROMPT`, `SRO_RECONCILE_PROMPT`)
is deleted in R4; the summary statement replaces it in both modes.

### 5.2 Review panel

Top to bottom:

1. **Action row**: `Review` (`control-review`, replaces `control-analyze` and `control-summary`),
   `Copy-edit` (`control-copyedit`), "Run one role ▾" (`control-analyze-agent`, now lists the five roles; a
   single-role run replaces only that role's open findings and does not produce a summary statement),
   Stop (`control-stop`) with the progress text.
2. **Summary card**: overall impact and factor scores labelled **Mock scores**; Factor 3 with "Judged from the
   text only; biosketches not seen"; each weakness is a button that scrolls the list to its findings
   (`control-summary-weakness`); role failures with Retry (`control-role-retry`).
3. **Findings**, grouped by factor (grant) or Major/Minor (manuscript), then by section. Filters: severity,
   role, section (`control-filter-severity`, `control-filter-role`, `control-filter-section`). Card: check name,
   quote or "Missing in <section title>", issue, recommendation, an `unverified` tag when it applies. Actions:
   Locate, Insert note, Dismiss, Draft a fix (`control-finding-fix`, quote-bearing findings only), Rebut.
4. **Edits** group (from Copy-edit), below the findings: Accept, Reject, Accept all, Reject all.
5. Style comparison and Chat sections, unchanged.

**Draft a fix** sends the finding's quote, issue and recommendation, the neighbouring sentences, the house style
and the voice profile to a rewrite call, runs the same guard, and shows the result as a pending edit on that
finding (Accept / Reject). It refuses missing-content findings ("write this part yourself; the AI will not invent
methods or data").

**Rebut** sends the author's argument, the finding and the section text (the full document on cloud); the reply
updates the `recommendation` the card shows, or closes the finding as dismissed when the model concedes.
(`rebutSuggestion` currently ignores `fullText` and updates `explanation`; both fixed.)

Every new control gets a literal `data-testid` and a row in `src/components/shell/reachability.test.tsx`; moved
controls update their rows. Selects and checkboxes in the filters get rows written by hand (the guards cannot see
them).

## 6. Measuring quality

`scripts/eval/review/` with `npm run eval:review -- --tier cloud|local --doc grant|manuscript`.

- **Grant fixture** (`fixture-grant.ts`): a synthetic R01, about 1,500 words, sections Project Summary, Specific
  Aims, Significance, Innovation, Approach (with Aim 1-3 subsections, Preliminary Data, Rigor, Timeline). About 15
  **planted weaknesses**, each `{ checkId, sectionTitles, quoteHints?, keywords, alsoIn? }`, including: Aim 2 depends on Aim 1; no power
  analysis for Aim 3; SABV never addressed in a mouse study; the Aims page lists Aim 3 that the Approach omits;
  n = 40 in Significance and n = 60 in Approach; innovation claimed for a standard method; no alternatives for
  Aim 2; a timeline that runs past the five-year project period; Project Summary describes a different aim.
  About 8 **traps**: passages that satisfy a check (a proper power analysis under a "Rigor" subheading, SABV
  justified, alternatives given for Aim 1, a defined abbreviation reused correctly).
- **Manuscript fixture**: the existing one, re-tagged with check ids, plus traps.
- **Scored per run**: recall and false alarms from a single assignment of each finding to at most one expectation.
  Tiers, in order, planted weaknesses first and then traps: (a) same `checkId` and quote overlap with a
  `quoteHint`; (b) same `checkId` and located in a listed section (exact section titles; an `alsoIn` section needs
  its cue in the text); (c) `keywords` match and quote overlap; (d) `keywords` match and located. The checkId
  outranks keywords, planted outranks traps, quote outranks location, ties go to fixture order. Recall is the
  planted weaknesses assigned at least once; a finding assigned to a trap is a false alarm; false alarms on traps; total findings (noise); LLM calls; wall time;
  for Copy-edit, guard rejections and edits that touch a citation.
- **Baseline**: R1 scores the current pipeline (`analyzeText` crew + study section) on the new fixtures before
  anything changes; the numbers are recorded in `docs/superpowers/plans/2026-07-04-eval-results.md`.
- **Gates** (checked at R2 and R4, both tiers must also beat the baseline). Copy-edit leaves Review in v2, so the
  comparison is against the baseline numbers EXCLUDING the editor agent (the eval reports both):

  | Tier | Recall | False alarms on traps |
  |---|---|---|
  | cloud | ≥ 80% | ≤ 1 |
  | local (ornith-9b) | ≥ 60% | ≤ 2 |

- **Private check**: the author's real R01 under `fixtures/private/` (gitignored), run by hand at the end of R3,
  findings read by the author.

The eval calls real providers and never runs in vitest.

## 7. Testing (vitest, no network)

Checklist invariants (§1.3); `sectionMap` on template-imprinted grants, Word-imported H1/H3 grants, IMRAD
manuscripts and headingless text; `resolveAnchor` (occurrence inside a section, duplicate quotes in different
sections, renamed heading, deleted quote, missing-content heading anchor); fact-sheet merge and cap;
`renderRolePrompt` (each check in exactly one prompt; section filtering; preamble override); finding validation
(enum rejection, dedupe, fingerprints, dismissal filtering); summary validation (score clamping, dangling ids);
detector regexes (grouped and ranged citations); edit guard wiring (a citation-changing edit is discarded).
Pipeline tests replay recorded responses through a fake `callLLM` and pin the call count per tier for a fixed
fixture; Stop mid-run leaves mapped findings and a `stopped` run. Reachability rows for every new control.

The gate for each milestone is unchanged: `npx tsc --noEmit`, `npx vitest run`, `npm run build`, all exit 0, and
`dist-electron/` churn reverted.

## 8. Build order

Each milestone gets its own implementation plan and merges to `main` when its gate passes.

| | Contents | Usable result |
|---|---|---|
| **R1** | checklist + invariants; `sectionMap`; `renderRolePrompt`; eval harness, both fixtures, scoring; baseline numbers for the current pipeline | baseline measured; nothing user-visible changes |
| **R2** | review engine, both tiers (role calls, fact sheet, cross checks, verify); `resolveAnchor` everywhere; findings store, Dexie v7, re-run replacement, dismissals; detector mapping and regex fix; Stop and progress | the existing Review list shows the new findings, correctly anchored; eval gates checked |
| **R3** | summary statement; Review panel layout (§5.2); filters; Draft a fix; Rebut fix; reachability rows | the review is a summary statement you can work through |
| **R4** | Copy-edit, house style, edit guard and citation-safe apply; delete the old crew (`GRANT_AGENT_PROMPTS`, `COMPACT_*`, find-then-fix for review, `runJudgeAgent`, `verifySuggestions` for edits, `runStudySectionPanel`, persona and SRO prompts, `pipelineMode` UI); update `CLAUDE.md`'s AI service section | edits are separate, guarded and in your voice; eval gates rechecked |

## 9. Risks

- **Local models and enums.** A 9B model may still emit ids outside the enum when the provider ignores
  `json_schema`; validation drops them and the eval counts the drops. If drops exceed 20% on ornith-9b, the
  local prompt switches to numbered checks (`1`, `2`, …) mapped back to ids.
- **Verify over-pruning.** A verifier that drops real findings lowers recall; the eval reports recall before and
  after verification so the cost is visible.
- **Section keys from headings.** Grants with no headings get a single section; checks still run (`any`), but
  cross checks lose precision. The card wording does not claim a section it does not know.
- **Mock scores.** A 1-9 score from a model can read as authoritative. It is always labelled "Mock scores" and
  shown with the findings it rests on.
