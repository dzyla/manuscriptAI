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
