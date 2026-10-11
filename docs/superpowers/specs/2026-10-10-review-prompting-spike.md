# Spike: how to prompt the review crew so a weak model still finds real weaknesses

Date: 2026-10-10. Model under test: **Qwen3.8-27B UD-IQ2_M** (2-bit, llama.cpp, 32k context, one slot, temperature 0,
thinking off) — a deliberately weak local model. Throwaway code lived in the session scratchpad and is not in the repo;
the checklist, section map, prompt renderer and scorer it used are the committed R1 modules.

## Why

R1 measured the old pipeline but did not ask how the *new* engine should prompt. The author asked for the strategy that
succeeds even with a weaker model, before R2 is planned.

## Test material

| Document | Tokens | Planted weaknesses | Traps |
|---|---|---|---|
| Synthetic R01 (R1 fixture) | 2,307 | 15 | 8 |
| Synthetic manuscript (R1 fixture) | 400 | 12 | 5 |
| **Michelson Prize essay** (author's, mutated) | 1,470 | 5 | 3 |
| **SNSF research plan** (author's, mutated) | 8,727 | 7 | 5 |
| **NIH R01 draft** (author's, mutated) | 25,383 | 9 | 6 |

The three real grants were mutated **blind**: one agent read only the checklist and the extracted text and wrote the
mutation spec (realistic single-point failures: a number changed in one place, an alternatives paragraph deleted, a
hypothesis vagued, a milestone pushed past the project period, a sub-aim added to the Approach only, a strain renamed
once, a power sentence deleted). The per-check procedures were written by a different agent that was forbidden to read
any fixture or grant. The author's text stayed in the session scratchpad and is not committed.

## Strategies compared

| | What the model is asked |
|---|---|
| **S1** | One call per **role** with all that role's checks and the whole document (the R2 spec as written). |
| **S2** | One call per **check**: document, then the check, then "copy the evidence, then rule pass / fail / not_applicable, then list problems". |
| **S3** | S2 **plus the check's procedure** (3-5 imperative steps naming the cues to search for) and one pass and one fail example. |
| **S4** | S3 **plus a skeptical second pass**: for every fail, "is there anything in the document that already satisfies this?" |
| **S5** | S3 but the model sees an **outline, the verbatim aims, and only the paragraphs a keyword search found relevant** (~1,800 words) instead of the whole document. |
| **S6** | S3 plus an **LLM fact sheet**: the document is split into parts, one call per part extracts aims, hypotheses, quantities, names and milestones; cross-document checks are judged from the merged sheet; per-aim checks run per Approach part. |

> **Re-measured 2026-10-11.** The tables below are corrected. Two things changed them: the scorer was rejecting
> correct findings whose quote was short but distinctive (now judged by distinctiveness; commits `368caa7`, `3a07a7c`),
> and four deterministic cross-document detectors were prototyped and measured. Where a number moved, the corrected
> one is used throughout.

## Results (recall on planted weaknesses / trap false alarms)

| Strategy | synth. grant | synth. manuscript | Michelson | SNSF | R01 | total | trap FA | calls |
|---|---|---|---|---|---|---|---|---|
| S1 role-batched | 13/15 | 8/12 | 4/5 | 5/7 | 2/9 | **32/48 (67%)** | 3 | 30 |
| S2 per check | 14/15 | 9/12 | 5/5 | 6/7 | 1/9 | **35/48 (73%)** | 2 | 133 |
| S3 per check + procedure | 13/15 | 10/12 | 5/5 | 6/7 | 1/9 | **35/48 (73%)** | **1** | 129 |
| S4 + skeptic | 12/15 | 10/12 | 5/5 | 6/7 | 1/9 | 34/48 (71%) | 1 | 238 |
| S5 retrieval | 14/15 | 10/12 | 5/5 | 5/7 | **3/9** | **37/48 (77%)** | 2 | 129 |
| S6 fact sheet | 12/15 | 8/12 | 5/5 | 4/7 | 1/9 | 30/48 (62%) | 1 | 243 |

Documents up to ~9k tokens only (everything except the R01): S1 30/39, S2 34/39, **S3 34/39 with the fewest false
alarms**, S4 33/39, S5 34/39, S6 29/39.

### Corrected results, and the deterministic detectors

LLM alone, re-scored:

| Strategy | synth. grant | synth. ms. | Michelson | SNSF | R01 | total | trap FA | calls |
|---|---|---|---|---|---|---|---|---|
| S1 role-batched | 13/15 | 8/12 | 4/5 | 5/7 | 4/9 | 34/48 (71%) | 3 | 25 |
| S2 per check | 14/15 | 9/12 | 5/5 | 6/7 | 2/9 | 36/48 (75%) | 2 | 133 |
| S3 per check + procedure | 13/15 | 10/12 | 5/5 | 6/7 | 2/9 | 36/48 (75%) | **1** | 129 |
| S4 + skeptic | 12/15 | 10/12 | 5/5 | 6/7 | 2/9 | 35/48 (73%) | 1 | 238 |
| S5 retrieval | 14/15 | 10/12 | 5/5 | 5/7 | 3/9 | 37/48 (77%) | 2 | 129 |
| S6 fact sheet | 12/15 | 8/12 | 5/5 | 4/7 | 1/9 | 30/48 (63%) | 1 | 243 |
| S7 per-aim scoping | not run | not run | not run | 6/7 | 3/9 | 9/16 | 0 | 141 |

The same runs with four deterministic cross-document detectors added:

| Strategy | synth. grant | synth. ms. | Michelson | SNSF | R01 | total | trap FA |
|---|---|---|---|---|---|---|---|
| S1 role-batched | 13/15 | 8/12 | 4/5 | 5/7 | 5/9 | 35/48 (73%) | 3 |
| **S3 per check + procedure** | 14/15 | 10/12 | 5/5 | **7/7** | 5/9 | **41/48 (85%)** | **1** |
| **S5 retrieval** | 14/15 | 10/12 | 5/5 | 6/7 | **6/9** | **41/48 (85%)** | 2 |
| S7 per-aim scoping | not run | not run | not run | 7/7 | 6/9 | 13/16 | 0 |

The detectors alone, with no model at all: 18 ms on the 25k-token R01, and no false alarm on any trap.

| Document | Caught deterministically |
|---|---|
| R01 | **4 of 9** — a dose given two ways, a strain renamed once, a milestone past the project period, a sub-aim missing from the Aims page |
| SNSF | 1 of 7 — the attachment protein renamed once |
| synthetic grant | 2 of 15 — the timeline overrun and the aim absent from the Approach |
| Michelson, synthetic manuscript | 0 (neither has a cross-document plant) |

The four are **quantity disagreement** (a number with a unit whose surrounding description matches another site with a
different value), **entity drift** (a name used once that is one character from a name used throughout),
**milestone overrun** (a year or quarter label beyond the project period) and **aim-list difference** (a set
difference between the aim labels on the Aims page and in the Approach). Together they beat every prompting strategy
on the R01, in 18 milliseconds, and they take the SNSF plan to 7 of 7.

Precision differs by detector and should drive how each is presented. Quantity disagreement, milestone overrun and
aim-list difference were exact on these five documents (every finding was a real problem). Entity drift was 2 right
out of 8 flagged: the rest were figure-panel labels and numbered variants ("F1" against "F2"). It should ship as a
short "names used once that resemble another name" list at minor severity, not as a finding card.

## What the numbers mean

1. **One call per check beats one call per role**, by about 10 points of recall, and halves the false alarms. The gain is
   consistent on four documents of three different kinds. A 2-bit model asked twelve things at once answers three of
   them; asked one thing at a time it answers it. The cost is 25-30 calls instead of 5, but the document is cached, so
   each later call only processes its ~500-token question.
2. **Procedures (S3) buy precision, not recall.** Same recall as S2, a third fewer unmatched findings, and the fewest
   trap false alarms of any strategy. The step that pays is "find the passage that would satisfy this check *first*,
   then rule".
3. **The skeptical second pass (S4) is not worth it.** No recall gain, double the calls, and it deleted two true
   findings on the synthetic grant.
4. **The LLM fact sheet (S6) failed.** Extraction from a 2-bit model is too lossy to judge from: recall fell on three
   of five documents and the run took 18 minutes on the R01.
5. **Retrieval (S5) is the only thing that scales.** Equal to S3 on short documents, best on the R01, and its prompts
   stay near 3k tokens whatever the document's length.
6. **The 25k-token R01 defeats prompting alone (1-4 of 9), and detectors are what rescue it (to 6 of 9).** The failures are of three kinds, and the diagnostic run
   shows which is which:
   - **Cross-document comparisons** (a dose given as 1 and 10 µg in one paragraph and 1 and 5 µg in the next; a strain
     called B3 in one sentence and D8 in another; a sub-aim present in the Approach and absent from the Aims page).
     Keyword retrieval cannot find these and the model never compares the two places. **No prompt fixes this.**
   - **Judgment failures where the model saw the right text**: it passed a vague Aim 2 hypothesis because a different
     aim had a testable one, and passed "alternatives missing for this sub-aim" because another sub-aim had some.
   - **Deletions**, which are found only when the check is asked about that one sub-aim.
7. **"Matches nothing" is not noise on a real document.** S6 produced 58 findings on the R01 that matched no plant and
   no trap; reading them, most are genuine weaknesses that I never planted (sub-aim after sub-aim states a group size
   with no power justification, and the proposal's own rigor section says "appropriate statistical tests will be
   applied" without naming one). The eval can only score what was planted, so the unmatched column must not be used to
   penalise a thorough strategy. Recall on plants stays a fair comparison because plants are known true positives.

## Recommended strategy for R2

**One call per check, evidence first, with the check's procedure; the document whole when it fits, retrieval-scoped
when it does not; per-aim checks asked once per aim; and cross-document consistency moved out of the LLM.**

Concretely, replacing §3.2 to §3.4 of the Review v2 spec:

1. **Prompt unit = one check**, not one role. System prompt: the reviewer context (document type, mechanism, project
   period) and the standing rules. User prompt: the document (or excerpts), then the check: id, name, question,
   "adequate when", the procedure's steps, a pass example and a fail example.
2. **Output order is fixed**: `evidence` (up to 3 passages copied from the document, or none), then
   `verdict` ∈ pass | fail | not_applicable, then `problems` (only when fail; each with section, quote or "", issue,
   recommendation). The evidence field is what suppresses false alarms, and `not_applicable` is what stops a model
   inventing a problem when a check does not apply.
3. **Checklist entries gain `steps`, `passExample`, `failExample`** (the procedure). They are data beside `question`
   and `passes`, written once per check and rendered into the prompt.
4. **Document delivery by size**: whole document when it is under ~8k tokens; otherwise the outline, the verbatim
   Specific Aims, and the paragraphs a deterministic search selects for that check (~1,800 words), with a score boost
   for paragraphs under a heading whose title matches the check's topic.
5. **Per-aim checks** (design, power, statistics, sex as a biological variable, blinding, replication, pitfalls,
   outcomes, preliminary data, measurable endpoint, expertise; and the manuscript rigor checks) **may** be asked once
   per aim or sub-aim, with any general rigor section attached to every call and the instruction to judge only that
   part. Measured in isolation (S7) this is worth **one extra planted weakness out of nine** on the R01 and takes the
   finding count from 17 to 54, at 94 calls against 28. It is how a study section actually reads an Approach, and it
   is the only thing that makes a deletion inside one sub-aim findable, but on this evidence it is **optional** and
   should be a setting, not the default. Retrieval (point 4) reaches the same R01 recall far more cheaply.
6. **Cross-document comparison becomes deterministic, and it is the single biggest win.** Four detectors —
   quantity disagreement, entity drift, milestone overrun, aim-list difference — caught 4 of 9 R01 plants in 18 ms
   with no false alarms, took the SNSF plan from 6/7 to 7/7, and raised the mixed-set total from 36-37/48 to 41/48.
   They cover `*-con-numbers`, the name half of `*-con-terms`, `g-fea-timeline` and `g-log-aims-approach`. Extend
   `src/services/detectors.ts`. Leave the LLM the judgment-shaped consistency checks (summary against aims, abstract
   against results). Present entity drift as a minor-severity name list, not a finding card (precision 2 of 8).
7. **Keep the verification call** from the spec (one batched pass over all findings), but drop the per-finding
   skeptical pass. Evidence-first prompting already does most of that work at a fraction of the cost.
8. **Cost on the local tier**: about 30 calls for a short document and about 90 for a 25k-token R01 (per-aim checks
   multiply), against 80-200 for today's pipeline. Prompt caching makes the per-check calls cheap after the first.
9. **Cloud tier**: keep one call per role. R1's baseline shows a strong model reaching 80% on the synthetic grant that
   way, and per-check prompting would cost it 6x the calls for a gain the weak model needed and a strong one may not.
   Adopt the evidence-first output and the procedures there too, since both are free. **This is an assumption, not a
   measurement** — see Not tested.

### What still escapes on the R01

With the best measured configuration (retrieval plus detectors, 6 of 9) three plants remain, and all three are a
single sentence deleted from or weakened inside a 25k-token document: the Aim 2 hypothesis reduced to "plays an
important role" on the Aims page only, the deleted power justification for the mouse groups, and the deleted sentence
stating that the microscopes are available. Per-aim scoping finds the power one; nothing found the other two. A
reviewer reading the Approach aim by aim would. This is the honest ceiling of the current design on a long document,
and R2 should report it rather than hide it.

## Gates for R2, revised from this evidence

The R1 gates (cloud ≥ 80%, local ≥ 60%) hold for documents up to ~9k tokens; the recommended configuration reaches
**85% on the mixed set** and **7/7 on the author's SNSF plan** with one false alarm. On a 25k-token real grant the
measured ceiling is **6 of 9**: make that the R2 gate for the long-document case, since it is reached by a
configuration that exists, and raise it when the remaining three (single deleted or weakened sentences) are addressed.

## Found by running on real grants (would not have surfaced on synthetic text)

- **The scorer was under-counting.** `quotesOverlap` demanded three space-separated words, so a correct finding
  quoting "receptor-bound HN" was scored as a miss; a 15-character floor then still rejected "Y6Q3 Go/No-Go". The rule
  is now distinctiveness: containment is refused only for a single alphabetic token under eight characters. This moved
  four R01 plants and one SNSF plant from missed to found, and it means **the R1 baseline numbers in
  `2026-07-04-eval-results.md` are slightly understated** — anything compared against them should be re-scored first.
- **Word's Symbol font breaks unit reading.** The R01 stores the micro sign as a literal private-use character
  (U+F06D), not as `<w:sym>`, so "5<U+F06D>g" is not a dose to any reader and a model quoting it produces a quote that
  cannot be found again. Ten occurrences in one file. The spike mapped the Symbol range itself; the real fix belongs in
  the DOCX reader and is recorded in `2026-10-08-carried-items.md`.
- **A regex with nested quantifiers hung on a 25k-token document.** Bounded repetition only, in anything that scans a
  whole grant.

## Not tested

- **Whether a strong model needs any of this.** Two attempts to run the comparison through a Claude stand-in failed: on
  the real grants a bio-content safety classifier blocked the agent carrying the measles-vaccine text, and the retry on
  the synthetic documents was abandoned for time. The cloud recommendation above is therefore an assumption.
- **Per-aim scoping on its own.** It was only ever run inside S6, together with the fact sheet that sank that run.
  Worth isolating in R2.
- Embedding-based retrieval instead of keyword retrieval; whether a better quantization of the same model changes the
  long-document result.

## Operational findings worth keeping

- A cloud safety classifier refused the author's measles-vaccine grant text in a subagent. Virology grants may be
  refused by hosted models, which is an argument for the local tier being a first-class path rather than a fallback.
- `llama-server` with `-np 1` and `cache_prompt` reuses the document across per-check calls: on the SNSF plan, 226k
  prompt tokens with 205k served from cache.
- Real grants need a wider heading classifier than the R1 section map has ("2.1 Current state of research", "A5.
  Scientific Rigor…", "C2.2b. Frequency of administration", run-in bold headings, "Reason for the choice of research
  institution"). The spike used a widened keyword table; R2 should fold it in.
