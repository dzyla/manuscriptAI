// THROWAWAY SPIKE (sub-project H, Task 6). Not production code. Nothing in src/ may import this.
//
// Question: can the local llama.cpp server give us per-token log-probabilities of SUPPLIED text
// (not generated text)? That is what a Binoculars-style detector needs, from two models.
//
// Run (only when the model server is already up; this script never starts one):
//   npx tsx scripts/spikes/binoculars-local.ts
// Optional env:
//   BASE=http://localhost:8080          observer server
//   MODEL=ornith                        model id sent in requests
//   BASE2=http://localhost:8081         second server (performer) for the cross-perplexity ratio
//   MODEL2=ornith2
//   MAXTOK=96                           tokens scored per text in the teacher-forcing fallback
//
// Exit codes: 0 = probes ran, 2 = server unreachable (informative message, nothing else attempted).

import { FIXTURE_MANUSCRIPT } from '../eval/fixture';

const BASE = (process.env.BASE ?? 'http://localhost:8080').replace(/\/$/, '');
const MODEL = process.env.MODEL ?? 'ornith';
const BASE2 = process.env.BASE2?.replace(/\/$/, '');
const MODEL2 = process.env.MODEL2 ?? MODEL;
const MAXTOK = Number(process.env.MAXTOK ?? 96);
const SAMPLE = 'The complex was purified by gel filtration.';

async function call(base: string, path: string, body?: unknown, timeoutMs = 60000): Promise<{ ok: boolean; status: number; text: string; json?: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, text, json };
  } finally { clearTimeout(t); }
}

const head = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + ' ...[truncated]' : s);

function show(label: string, r: { status: number; text: string }) {
  console.log(`\n--- ${label}\nHTTP ${r.status}\n${head(r.text)}`);
}

/** Probe 1-4. Returns which route (if any) gives prompt log-probs. */
async function probe(base: string, model: string): Promise<'v1-echo' | 'native-nprobs' | 'none'> {
  let route: 'v1-echo' | 'native-nprobs' | 'none' = 'none';

  const p1 = await call(base, '/v1/completions', { model, prompt: SAMPLE, max_tokens: 0, echo: true, logprobs: 1 });
  show('PROBE A  POST /v1/completions  echo:true max_tokens:0 logprobs:1', p1);
  const lp = p1.json?.choices?.[0]?.logprobs?.token_logprobs;
  if (p1.ok && Array.isArray(lp) && lp.length > 1) route = 'v1-echo';

  const p2 = await call(base, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, logprobs: true, top_logprobs: 1 });
  show('PROBE B  POST /v1/chat/completions  logprobs:true (generated tokens only, shown for completeness)', p2);

  const p3 = await call(base, '/completion', { prompt: SAMPLE, n_predict: 0, n_probs: 1 });
  show('PROBE C  POST /completion  n_predict:0 n_probs:1', p3);
  const cp = p3.json?.completion_probabilities;
  if (route === 'none' && p3.ok && Array.isArray(cp) && cp.length >= 2) route = 'native-nprobs';

  const p4 = await call(base, '/tokenize', { content: SAMPLE });
  show('PROBE D  POST /tokenize', p4);
  return route;
}

/** Native /completion with n_predict:0 does not emit prompt probs on builds checked; fallback is teacher forcing. */
async function tokenize(base: string, text: string): Promise<number[]> {
  const r = await call(base, '/tokenize', { content: text });
  if (!r.ok || !Array.isArray(r.json?.tokens)) throw new Error(`/tokenize failed: HTTP ${r.status} ${head(r.text, 200)}`);
  return r.json.tokens as number[];
}

type Dist = Map<number, number>; // token id -> logprob (top-K only)

/**
 * Teacher forcing: for each position i, ask for ONE generated token after prefix tokens[0..i) with n_probs=K.
 * Gives top-K log-probs of the next token. The actual token's logprob is exact only if it is inside top-K,
 * and cross-entropy against the second model is a TOP-K APPROXIMATION. Costs one request per token.
 */
async function teacherForce(base: string, tokens: number[], K = 200): Promise<{ dists: Dist[]; actualLp: number[] }> {
  const dists: Dist[] = [];
  const actualLp: number[] = [];
  const n = Math.min(tokens.length, MAXTOK);
  for (let i = 1; i < n; i++) {
    const r = await call(base, '/completion', { prompt: tokens.slice(0, i), n_predict: 1, n_probs: K, temperature: 0, cache_prompt: true, post_sampling_probs: false }, 120000);
    if (!r.ok) throw new Error(`/completion HTTP ${r.status}: ${head(r.text, 300)}`);
    const top = r.json?.completion_probabilities?.[0]?.top_logprobs ?? r.json?.completion_probabilities?.[0]?.top_probs;
    if (!Array.isArray(top)) throw new Error(`unexpected completion_probabilities shape: ${head(r.text, 400)}`);
    const d: Dist = new Map();
    for (const e of top) d.set(e.id, e.logprob ?? Math.log(e.prob));
    dists.push(d);
    actualLp.push(d.get(tokens[i]) ?? Math.log(1e-9)); // floor when outside top-K
  }
  return { dists, actualLp };
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

function crossPerplexity(obs: Dist[], perf: Dist[]): number {
  // -mean_i sum_v p_perf(v) * log p_obs(v), over tokens present in both top-K lists, renormalised.
  const per: number[] = [];
  for (let i = 0; i < Math.min(obs.length, perf.length); i++) {
    let z = 0; const keys: number[] = [];
    for (const [id, lp] of perf[i]) if (obs[i].has(id)) { keys.push(id); z += Math.exp(lp); }
    if (!z) continue;
    per.push(-keys.reduce((s, id) => s + (Math.exp(perf[i].get(id)!) / z) * obs[i].get(id)!, 0));
  }
  return mean(per);
}

async function generateSample(): Promise<string> {
  const r = await call(BASE, '/v1/chat/completions', {
    model: MODEL, max_tokens: 200, temperature: 0.7,
    messages: [{ role: 'user', content: 'Write one paragraph (4-5 sentences) of a scientific Methods section describing purification of a recombinant protein complex. Plain prose, no headings.' }],
  }, 180000);
  const t = r.json?.choices?.[0]?.message?.content;
  if (!r.ok || typeof t !== 'string') throw new Error(`generation failed: HTTP ${r.status} ${head(r.text, 300)}`);
  return t.trim();
}

async function main() {
  console.log('THROWAWAY SPIKE: Binoculars feasibility against a local llama.cpp server. Not production code.');
  console.log(`observer: ${BASE} (model "${MODEL}")  performer: ${BASE2 ? `${BASE2} ("${MODEL2}")` : '(none given)'}`);

  const models = await call(BASE, '/v1/models').catch((e) => ({ ok: false, status: 0, text: String(e), json: undefined as any }));
  if (!models.ok) {
    console.error(`\nSERVER NOT REACHABLE at ${BASE}/v1/models (${head(models.text, 200)}).`);
    console.error('This script never starts a server. Start one deliberately, check free VRAM first (nvidia-smi),');
    console.error('then re-run. The project notes say: `ai-backend llama`. Nothing was measured.');
    process.exit(2);
  }
  show('PROBE 0  GET /v1/models', models);

  const route = await probe(BASE, MODEL);
  console.log(`\n=== Prompt-logprob route found by direct probes: ${route} ===`);
  if (route === 'none') console.log('Direct prompt log-probs unavailable; trying the teacher-forcing fallback (one request per token, top-K only).');

  const para = FIXTURE_MANUSCRIPT.split(/\n\s*\n/).find((p) => p.length > 200) ?? FIXTURE_MANUSCRIPT.slice(0, 600);
  let generated = '';
  try { generated = await generateSample(); } catch (e) { console.log(`\nCould not generate machine sample: ${e}`); }
  const texts: Array<[string, string]> = [['fixture paragraph', para], ...(generated ? [['model-generated paragraph', generated] as [string, string]] : [])];

  for (const [name, text] of texts) {
    console.log(`\n=== ${name} (${text.length} chars) ===`);
    try {
      const toks = await tokenize(BASE, text);
      const obs = await teacherForce(BASE, toks);
      const logPPL = -mean(obs.actualLp);
      console.log(`observer log-perplexity over ${obs.actualLp.length} tokens: ${logPPL.toFixed(3)}`);
      if (!BASE2) { console.log('No BASE2 given: cross-perplexity and the Binoculars ratio were NOT computed.'); continue; }
      const toks2 = await tokenize(BASE2, text);
      if (toks2.length !== toks.length || toks2.some((t, i) => t !== toks[i])) {
        console.log('Tokenizers differ between the two servers: Binoculars is not defined. Stop.'); continue;
      }
      const perf = await teacherForce(BASE2, toks);
      const x = crossPerplexity(obs.dists, perf.dists);
      console.log(`cross-perplexity (top-K approx): ${x.toFixed(3)}   Binoculars score = logPPL / xPPL = ${(logPPL / x).toFixed(3)}  (lower = more machine-like in the paper)`);
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch((e) => { console.error(`Spike aborted: ${e instanceof Error ? e.message : e}`); process.exit(1); });
