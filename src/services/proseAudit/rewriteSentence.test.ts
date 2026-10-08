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

  it('after two failures returns the better attempt flagged', async () => {
    const dropsBoth = 'Kinetics select the state. We measured complexes at pH 5.5.';
    const dropsOne = 'Kinetics select the state. We measured complexes at pH 5.5 [3].';
    mock.mockResolvedValueOnce(dropsBoth).mockResolvedValueOnce(dropsOne);
    const r = await rewriteSentence({ sentence, settings });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(r.retried).toBe(true);
    expect(r.text).toBe(dropsOne);
    expect(r.warnings.join(' ')).toMatch(/42/);
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

  it('does not let lint re-append dropped citations: a reply with none is flagged, not silently repaired', async () => {
    const reply = 'Kinetics select the state. We measured 42 complexes at pH 5.5.';
    mock.mockResolvedValue(reply);
    const r = await rewriteSentence({ sentence, settings });
    expect(r.text).toBe(reply);
    expect(r.warnings.join(' ')).toMatch(/\[3\] is missing/);
  });

  it('collapses a multi-line reply to one line (a newline would become a hard break in the editor)', async () => {
    mock.mockResolvedValueOnce('Kinetics select the state.\nWe measured 42 complexes at pH 5.5 [3].');
    const r = await rewriteSentence({ sentence, settings });
    expect(r.text).toBe('Kinetics select the state. We measured 42 complexes at pH 5.5 [3].');
    expect(r.text).not.toMatch(/\n/);
  });

  it('returns the attempt with fewer failed guards, whichever order they come in', async () => {
    const twoReasons = 'Kinetics select the state. We measured complexes at pH 5.5.';
    const oneReason = 'Kinetics select the state. We measured complexes at pH 5.5 [3].';
    mock.mockResolvedValueOnce(twoReasons).mockResolvedValueOnce(oneReason);
    expect((await rewriteSentence({ sentence, settings })).text).toBe(oneReason);
    mock.mockReset();
    mock.mockResolvedValueOnce(oneReason).mockResolvedValueOnce(twoReasons);
    expect((await rewriteSentence({ sentence, settings })).text).toBe(oneReason);
  });

  it('on a tie returns the second attempt', async () => {
    const a = 'Kinetics select the state. We measured complexes at pH 5.5 [3].';
    const b = 'Kinetics decide the state. We measured complexes at pH 5.5 [3].';
    mock.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    expect((await rewriteSentence({ sentence, settings })).text).toBe(b);
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
