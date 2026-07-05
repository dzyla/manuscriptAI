# Task 6: Empirical prompt-tuning pass — eval results

Live model: `ornith` (ornith-9b-mtp-kl-Q4_K_M.gguf) served at `http://localhost:8080/v1/chat/completions`.
Harness: `npm run eval:local` (see `scripts/eval/run.ts`, `scripts/eval/fixture.ts`, `scripts/eval/checks.ts`).

Note on determinism: the harness talks to a live, sampling local model. Numbers can shift
slightly between runs even with no code changes — Task 5's recorded baseline was 17/18 with a
`consistency-1` miss; the baseline run captured below (same code, same prompts) came back 18/18
with the trim quality check failing instead. Both are legitimate outputs of the same prompts; this
doc records what the harness actually printed on each run, not what was expected in advance.

## Baseline

Command: `npm run eval:local`

```
> EVAL_PROVIDER=local EVAL_LOCAL_URL=http://localhost:8080/v1/chat/completions EVAL_LOCAL_MODEL=ornith npx tsx scripts/eval/run.ts
Eval harness — provider=local model=ornith
editor             … recall 4/4 (100%)  · 10 suggestions
researcher         … recall 4/4 (100%)  · 15 suggestions
reviewer-2         … recall 3/3 (100%)  · 12 suggestions
citation-checker   … recall 2/2 (100%)  · 10 suggestions
statistician       … recall 3/3 (100%)  · 14 suggestions
consistency        … recall 1/1 (100%)  · 10 suggestions
manager            … recall 1/1 (100%)  · 12 suggestions
──────────────────────────────
Overall recall:   18/18 (100%)
On-target rate:   16/83 suggestions matched a seeded issue
(On-target is a loose proxy — off-seed suggestions can still be valid.)
Quality checks
──────────────────────────────
trim         FAIL  (86 -> 43 words, budget 40)
   got: We performed experiments to determine whether the compound inhibited the enzyme. It was observed that the compound inhibited the enzyme in a dose-dependent mann
autocomplete PASS  (31 words)
   got: we fitted the data to a four-parameter logistic model to determine the half-maximal inhibitory concentration (IC50). The resulting IC50 value was 12.4 ± 0.8 nM,
```

**Weakest signal:** the `trim` quality check — over budget by 3 words (43 vs. a 40-word budget)
after the harness's built-in 3-attempt retry loop (`trimSectionToLimit` in `src/services/ai.ts`,
via `bestTrimCandidate`, which keeps the shortest candidate across attempts). Agent recall is
already 18/18, so there is no recall regression to chase this iteration; the target is tightening
`trimSectionToLimit`'s system prompt so the model lands under budget within the existing retry
budget instead of consistently landing a few words over.

Looking at `trimSectionToLimit`'s system prompt (`src/services/ai.ts`, function starting ~line
2649), the instruction says "at most N words" but never tells the model to leave margin below the
limit or to count before returning. With small local models, "at most N" is frequently read as "N
is fine," landing right at or slightly over the ceiling.

## Iteration 1

**Change:** In `trimSectionToLimit`'s system prompt, replaced the flat "at most N words" rule with
an explicit target range (`N-5` to `N` words) plus a self-check instruction ("Before you answer,
count the words in your draft. If it is over N words, cut another sentence or clause and count
again."). No structural change — JSON-output rules, quoting rules, and the retry loop in
`trimSectionToLimit` itself were untouched.

Command: `npm run eval:local`

```
Eval harness — provider=local model=ornith
editor             … recall 4/4 (100%)  · 8 suggestions
researcher         … recall 4/4 (100%)  · 13 suggestions
reviewer-2         … recall 3/3 (100%)  · 10 suggestions
citation-checker   … recall 2/2 (100%)  · 9 suggestions
statistician       … recall 3/3 (100%)  · 10 suggestions
consistency        … recall 1/1 (100%)  · 10 suggestions
manager            … recall 1/1 (100%)  · 12 suggestions
──────────────────────────────
Overall recall:   18/18 (100%)
On-target rate:   16/72 suggestions matched a seeded issue
Quality checks
──────────────────────────────
trim         PASS  (86 -> 40 words, budget 40)
autocomplete PASS  (32 words)
   got: we fitted the data to a four-parameter logistic model to determine the half-maximal inhibitory concentration (IC50). The resulting IC50 value was 12.4 ± 0.8 nM,
```

**Result:** trim flipped FAIL -> PASS (43 -> 40 words, exactly at budget). Recall held at 18/18,
autocomplete still PASS. **Kept.**

## Stability check (no prompt change)

Given the model is a live, sampling local LLM (this is exactly why the Task 5 baseline and this
session's baseline disagreed on the consistency-1 seed), re-ran the harness once more with no code
changes to confirm Iteration 1 holds up and isn't a one-off lucky sample.

Command: `npm run eval:local`

```
Eval harness — provider=local model=ornith
editor             … recall 4/4 (100%)  · 9 suggestions
researcher         … recall 4/4 (100%)  · 14 suggestions
reviewer-2         … recall 3/3 (100%)  · 10 suggestions
citation-checker   … recall 2/2 (100%)  · 9 suggestions
statistician       … recall 3/3 (100%)  · 14 suggestions
consistency        … recall 1/1 (100%)  · 10 suggestions
manager            … recall 1/1 (100%)  · 14 suggestions
──────────────────────────────
Overall recall:   18/18 (100%)
On-target rate:   16/80 suggestions matched a seeded issue
Quality checks
──────────────────────────────
trim         PASS  (86 -> 35 words, budget 40)
autocomplete PASS  (14 words)
   got: the IC50 values were determined by fitting the data to a four-parameter logistic model.
```

**Result:** Recall 18/18 again, trim PASS again (this time with more margin, 35/40 words),
autocomplete PASS. Iteration 1's change is stable across repeated live-model runs.

## Decision: stop after 1 iteration

After Iteration 1, every measured signal is at ceiling and stable across two repeated runs:
overall recall 18/18 (100%), trim PASS, autocomplete PASS. There is no remaining FAILing quality
check and no under-recalling agent to target — the `consistency-1` miss called out in the Task 5
baseline did not reproduce in either of this session's live-model runs (both scored consistency
1/1). Per the guardrails ("STOP after at most 4 iterations, or earlier once numbers plateau" and
"do NOT rewrite prompts wholesale"), further edits to already-maxed prompts would only add
regression risk for no measurable gain, so tuning stops here at 1 kept iteration.

The `on-target rate` (16/72-83 suggestions match a seed) stayed roughly flat across all runs and is
explicitly documented in the harness output as "a loose proxy — off-seed suggestions can still be
valid," not a pass/fail gate, so it was not used to justify further prompt changes.

## Final numbers

| Metric | Baseline | Final (Iteration 1 + stability check) |
|---|---|---|
| Overall recall | 18/18 (100%) | 18/18 (100%), confirmed twice |
| trim quality check | FAIL (86 -> 43 words, budget 40) | PASS (86 -> 40, then 86 -> 35 words, budget 40) |
| autocomplete quality check | PASS (31 words) | PASS (32 words, then 14 words) |

**Prompt changes kept:** `trimSectionToLimit`'s system prompt in `src/services/ai.ts` — target range
(`N-5` to `N` words) plus a self-count-and-recheck instruction, replacing the flat "at most N
words" phrasing that let the model land a few words over budget.
