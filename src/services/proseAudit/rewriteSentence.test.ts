import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ai', async () => {
  const actual = await vi.importActual<typeof import('../ai')>('../ai');
  return { ...actual, callLLM: vi.fn() };
});

import { callLLM } from '../ai';
import { rewriteSentence } from './rewrite';
import type { AISettings } from '../../types';

const settings = { provider: 'local' } as AISettings;
const sentence = 'The state is selected kinetically rather than thermodynamically; we measured 42 complexes at pH 5.5 [3].';
const good = 'Kinetics select the state. We measured 42 complexes at pH 5.5 [3].';
const mock = vi.mocked(callLLM);

beforeEach(() => mock.mockReset());

describe('rewriteSentence', () => {
  it('returns a passing first attempt without retrying', async () => {
    mock.mockResolvedValueOnce(good);
    const r = await rewriteSentence({ sentence, settings });
    expect(r).toEqual({ text: good, retried: false, warnings: [] });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('strips a thinking block, a label and quotes before checking', async () => {
    mock.mockResolvedValueOnce(`<think>plan</think>Rewritten sentence: "${good}"`);
    const r = await rewriteSentence({ sentence, settings });
    expect(r.text).toBe(good);
  });

  it('retries once with the failure reason in the prompt', async () => {
    mock.mockResolvedValueOnce('Kinetics select the state. We measured complexes at pH 5.5 [3].').mockResolvedValueOnce(good);
    const r = await rewriteSentence({ sentence, settings });
    expect(r).toEqual({ text: good, retried: true, warnings: [] });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0]).toMatch(/number 42 is missing/);
  });

  it('fails when the model keeps returning the sentence unchanged', async () => {
    mock.mockResolvedValue(sentence);
    await expect(rewriteSentence({ sentence, settings })).rejects.toThrow(/usable rewrite/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('fails on an empty reply', async () => {
    mock.mockResolvedValue('   ');
    await expect(rewriteSentence({ sentence, settings })).rejects.toThrow();
  });

  it('propagates an aborted request and does not retry', async () => {
    const ac = new AbortController();
    mock.mockImplementationOnce(async () => { ac.abort(); throw new DOMException('aborted', 'AbortError'); });
    await expect(rewriteSentence({ sentence, settings, signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('does not make the second call when the signal aborted between attempts', async () => {
    const ac = new AbortController();
    mock.mockImplementationOnce(async () => { ac.abort(); return 'Kinetics select the state.'; });
    await expect(rewriteSentence({ sentence, settings, signal: ac.signal })).rejects.toThrow(/cancel/i);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('rewriteSentence: round-1 pins', () => {
  const prof = (meanWords: number) => ({
    id: 'v', name: 'mine', createdAt: 0, sampleWords: 2000,
    summary: { sentences: 10, meanWords, pctOver35: 1, lengthCv: 0.5, counts: {}, rates: {} },
    exampleSentences: [],
  });

  it('an en-dash reply passes end to end, unflagged and unmangled (the lint used to turn H1–H3 into "H1, H3")', async () => {
    const o = 'We used 10–20 nM ligand against H1–H3 [3–5]; the signal rather than the noise decided the call.';
    const reply = 'We used 10–20 nM ligand against H1–H3 [3–5]. The signal decided the call.';
    mock.mockResolvedValueOnce(reply);
    const r = await rewriteSentence({ sentence: o, settings });
    expect(r).toEqual({ text: reply, retried: false, warnings: [] });
  });

  it('collapses a multi-line reply to one line (a newline would become a hard break in the editor)', async () => {
    mock.mockResolvedValueOnce('Kinetics select the state.\nWe measured 42 complexes at pH 5.5 [3].');
    const r = await rewriteSentence({ sentence, settings });
    expect(r.text).toBe('Kinetics select the state. We measured 42 complexes at pH 5.5 [3].');
    expect(r.text).not.toMatch(/\n/);
  });

  it('targets the profile mean sentence length, floors it at 10 and defaults to 18', async () => {
    mock.mockResolvedValue(good);
    await rewriteSentence({ sentence, settings, profile: prof(23.4) });
    expect(mock.mock.calls[0][0]).toMatch(/about 23 words/);
    mock.mockClear();
    await rewriteSentence({ sentence, settings, profile: prof(4) });
    expect(mock.mock.calls[0][0]).toMatch(/about 10 words/);
    mock.mockClear();
    await rewriteSentence({ sentence, settings });
    expect(mock.mock.calls[0][0]).toMatch(/about 18 words/);
  });
});

describe('rewriteSentence: fact failures are refused, style failures are flagged', () => {
  const sem = 'Binding fell at low pH; the effect was large in all six replicates.';
  const styleOne = 'Binding fell at low pH; the effect was large in six replicates.'; // keeps the semicolon: 1 style reason
  const styleTwo = 'Binding fell at low pH; the effect was large in all six replicates and we think this reflects protonation of interface residues under those conditions.'; // semicolon + much longer: 2

  it('refuses, after one retry, a rewrite that dropped a number: it is never handed back', async () => {
    mock.mockResolvedValue('Kinetics select the state. We measured complexes at pH 5.5 [3].');
    await expect(rewriteSentence({ sentence, settings })).rejects.toThrow(/safe rewrite.*number 42/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('refuses a rewrite that dropped every citation (lint does not repair it silently)', async () => {
    mock.mockResolvedValue('Kinetics select the state. We measured 42 complexes at pH 5.5.');
    await expect(rewriteSentence({ sentence, settings })).rejects.toThrow(/\[3\]/);
  });

  it('prefers the attempt with fewer FACT failures even when it has more failures in all', async () => {
    const o = 'Binding fell at pH 5; the effect was large in all six replicates.';
    const oneFact = 'Binding fell. The effect was large in all six replicates.'; // loses the 5: 1 fact, 0 style
    const twoStyle = 'Binding fell at pH 5; the effect was large in all six replicates and we think this reflects protonation of interface residues.'; // 0 fact, 2 style
    mock.mockResolvedValueOnce(oneFact).mockResolvedValueOnce(twoStyle);
    expect((await rewriteSentence({ sentence: o, settings })).text).toBe(twoStyle);
    mock.mockReset();
    mock.mockResolvedValueOnce(twoStyle).mockResolvedValueOnce(oneFact);
    expect((await rewriteSentence({ sentence: o, settings })).text).toBe(twoStyle);
  });

  it('flags a style-only failure and returns it', async () => {
    mock.mockResolvedValue(styleOne);
    const r = await rewriteSentence({ sentence: sem, settings });
    expect(r.text).toBe(styleOne);
    expect(r.retried).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/style score/);
  });

  it('returns the style attempt with fewer failures, in either order', async () => {
    mock.mockResolvedValueOnce(styleTwo).mockResolvedValueOnce(styleOne);
    expect((await rewriteSentence({ sentence: sem, settings })).text).toBe(styleOne);
    mock.mockReset();
    mock.mockResolvedValueOnce(styleOne).mockResolvedValueOnce(styleTwo);
    expect((await rewriteSentence({ sentence: sem, settings })).text).toBe(styleOne);
  });

  it('on a tie returns the second attempt', async () => {
    const other = 'Binding fell at low pH; the effect was large across six replicates.';
    mock.mockResolvedValueOnce(styleOne).mockResolvedValueOnce(other);
    expect((await rewriteSentence({ sentence: sem, settings })).text).toBe(other);
  });
});
