# Binoculars feasibility spike (H, Task 6) - findings

Throwaway spike. Probe script: `scripts/spikes/binoculars-local.ts` (nothing in `src/` imports it).

## Recommendation: NO-GO for a Tier-2 Binoculars score in the app

Go-if (all three must hold, and none is cheap): (1) a runtime that returns true prompt log-probs, or an accepted teacher-forcing cost; (2) two tokenizer-compatible models fit resident together with the user's normal workload; (3) a calibration set of the author's own text shows a threshold that does not flag it. Today none of the three is established, and the third is the one most likely to fail.

## 1. Does this llama.cpp build return log-probs of supplied text? No, not directly.

Build: `llama-server --version` -> `version: 0.5.0-dev (build 1, commit ef45f212c)`.

Evidence from the installed binary:
- `llama-server --help` contains no `--logits-all`, no `prompt_logprobs`, no perplexity option; `llama-cli --help` has none either. There is no `llama-perplexity` binary in `~/.local/bin`.
- `strings llama-server` has `n_probs` ("Return probabilities of top n_probs tokens after applying the sampling chain"), `post_sampling_probs`, `completion_probabilities`, `top_logprobs`, `return_tokens`; it has no `prompt_logprobs`. These describe generated tokens.
- `/v1/completions` carries an `echo` parameter with the help text "Whether to echo the input tokens in the output" and an error string `Only no echo is supported`.
- Live probe, one run, on the server that was up (model `Ornith-1.5-35B-Q4_K_M.gguf`):
  - A `POST /v1/completions {prompt, max_tokens:0, echo:true, logprobs:1}` -> HTTP 200, but `text:"\n"`, `completion_tokens:1`, `logprobs.content` with ONE entry (the generated `\n`, logprob -0.733). `echo` was ignored, `max_tokens:0` was ignored, and there is no `token_logprobs` array over the prompt. Not usable.
  - B `POST /v1/chat/completions {max_tokens:1, logprobs:true, top_logprobs:1}` -> HTTP 200, `logprobs.content[0]` for the single generated token only (shape `{id, token, bytes, logprob, top_logprobs[]}`).
  - C `POST /completion {n_predict:0, n_probs:1}` -> HTTP 200, but `tokens_predicted:1`, `tokens_evaluated:8`: it generated a token anyway. No prompt probabilities.
  - D `POST /tokenize` works: `{"tokens":[760,6150,557,88347,539,17304,72386,13]}`.

Only workaround found: teacher forcing. Per position, send the token-id prefix to `/completion` with `n_predict:1, n_probs:K, cache_prompt:true` and read `completion_probabilities[0]` top-K for the next token. Cost is one request per scored token. The log-prob of the real next token is exact only if it falls in the top K, and cross-perplexity can only be a top-K approximation. The script implements this and it ran end to end on the single model (no exceptions). I did not inspect the raw `completion_probabilities` JSON beyond that, and I did not verify that `post_sampling_probs:false` returns pre-truncation probabilities when the server defaults are top_k 20 / min_p 0.05. That affects the numbers below.

## 2. Second model and memory cost

`~/.local/share/ai/models` holds: Ornith-1.5-9B Q4_K_M (5.5 GB), ornith-1.0-9b Q4_K_M (5.4 GB), ornith-9b-mtp-kl Q4_K_M (5.5 GB), Ornith-1.5-35B Q4_K_M (20.7 GB, MoE, run with `--n-cpu-moe 25`), Qwen3.8-27B IQ2/IQ3 (6.9-10 GB), gemma-4-E4B (4.0 GB), LFM2.5-2.6B (1.6 GB). The server config is a 35B model at 131072 context with q4_0 KV cache.

Binoculars needs an observer and a performer with the SAME tokenizer, conventionally a base model and its instruct sibling (the paper used Falcon-7B and Falcon-7B-instruct). I did not verify tokenizer identity for any pair here (the script checks it and stops if they differ). The Ornith 9B variants are likely candidates; none is a clean base/instruct pair that I could confirm.

VRAM arithmetic (estimates, not measurements):
- Two 9B at Q4_K_M: about 11 GB of weights.
- KV at a grant-section length (2-4k tokens) with q4_0: small, order of 0.1-0.4 GB per model (architecture not read; estimate).
- Compute buffers: the live config uses `--ubatch-size 2048`, which costs real VRAM; a spike config would cut that to 512. Allow roughly 0.5-1 GB per server.
- Total: about 12-13.5 GB. Feasible on an otherwise empty 16 GB card, with little headroom.
- Card state: RTX 5080, 16303 MiB total. 13627 MiB was in use BEFORE any server of mine existed (measured before my first run; 13671 MiB after). That leaves about 2.6 GB. Even ONE 9B Q4 (5.5 GB) does not fit in that, let alone two.
- Plain answer: two models do not fit alongside the user's normal workload. The 35B server and a Binoculars pair cannot be resident together, and the pair would have to displace whatever holds the 13.6 GB. 35B + 9B is not an option either (20.7 GB of weights).
- Smaller pairs (gemma-E4B with LFM-2.6B) differ in tokenizer, so they are not valid Binoculars pairs.

## 3. Measured log-perplexity (single observer model, teacher forcing, top-200, 35B)

| text | tokens scored | observer log-perplexity |
|---|---|---|
| paragraph of `FIXTURE_MANUSCRIPT` | 53 | 3.654 |
| paragraph generated by the same model | 90 | 0.858 |

The gap is large in the expected direction. Caveats: one sample each; the generating model is the scoring model, which is the best case for any detector; the fixture paragraph is itself partly synthetic; target tokens outside the top 200 are floored at log(1e-9), which inflates the first number. Cross-perplexity and the Binoculars ratio were NOT computed: no second model was available or loaded. These numbers show only that the script works and that same-model output is easy to separate from unrelated text. They say nothing about the case that matters (the author's own prose against edited or lightly AI-assisted prose).

## 4. Fitness for this purpose

- Output shape. Binoculars yields one scalar per passage that is read as a verdict against a threshold. The sub-project's standing rule is to measure style and never claim authorship. A score with a published threshold invites exactly that claim.
- False positives. Perplexity-family detectors are known to flag non-native English and formulaic technical prose (low perplexity because the wording is conventional). This author is a non-native writer producing grant and Methods text, which is the worst case. The paper's thresholds were calibrated on Falcon-7B pairs and native-leaning corpora; for an Ornith pair there is no calibration, and building one means collecting labelled text of this author's, which the project holds as the voice baseline.
- Actionability. The score is per passage and gives no location, no cause and no edit. Tier 1 already gives per-sentence tells with evidence, a distance to the author's own voice profile, and a guarded rewrite that preserves numbers, units and citation atoms. A passage-level "looks machine-like" number cannot say which sentence to change, and a reviewer cannot be shown it as evidence. I see nothing it would tell this author that Tier 1 does not, other than a second opinion that can be wrong in the same direction as the person it is meant to protect.
- Cost. Teacher forcing at one request per token (a 3k-token section is about 3000 calls per model), two resident models, and stopping the normal server while it runs.

## What remains unmeasured

Because the spike was scoped to avoid loading a model, and only one model was ever available: the cross-perplexity and Binoculars ratio on any text; whether any other pair shares a tokenizer; real VRAM of a two-server pair; teacher-forcing wall time at section length; the raw `completion_probabilities` shape and pre/post truncation behaviour; any score on human text of a non-native writer (the decisive test).

## One command to finish the measurement

With a second server on port 8081 (start deliberately, after checking `nvidia-smi` for free VRAM):

    BASE2=http://localhost:8081 MODEL2=ornith npx tsx scripts/spikes/binoculars-local.ts

Without `BASE2` it still prints all probes and the single-model numbers. If the server is down it prints an explanation and exits 2.

## Process note

My first run of the script hit port 8080 while the user believed the server was down. The service `llama-server.service` showed as started at 09:41:38, about when I ran it, and it serves `Ornith-1.5-35B` behind an on-demand wrapper with `--sleep-idle-seconds 90`. I cannot rule out that my request woke it. GPU memory was 13627 MiB before and 13671 MiB after, so no new large allocation was observed. I stopped querying after that.
