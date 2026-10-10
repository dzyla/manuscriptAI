import { describe, it, expect } from 'vitest';
import { parseArgs, buildSettings, modelLabel, installCallCounter } from './run';
import { baselineCrew } from './baseline';

describe('parseArgs', () => {
  it('defaults to the local tier and both documents', () => {
    expect(parseArgs([])).toEqual({ tier: 'local', docs: ['grant', 'manuscript'] });
  });

  it('reads --tier and --doc', () => {
    expect(parseArgs(['--tier', 'cloud', '--doc', 'grant'])).toEqual({ tier: 'cloud', docs: ['grant'] });
    expect(parseArgs(['--doc=manuscript', '--tier=local'])).toEqual({ tier: 'local', docs: ['manuscript'] });
  });

  it('rejects unknown values', () => {
    expect(() => parseArgs(['--tier', 'gpu'])).toThrow(/--tier/);
    expect(() => parseArgs(['--doc', 'poem'])).toThrow(/--doc/);
  });
});

describe('buildSettings', () => {
  it('local tier: llama.cpp defaults and 2000-char chunks', () => {
    const s = buildSettings('local', {});
    expect(s).toMatchObject({ provider: 'local', localBaseUrl: 'http://localhost:8080/v1/chat/completions', localModel: 'ornith', localChunkSize: 2000 });
  });

  it('cloud tier: provider from env, whole-document calls', () => {
    const s = buildSettings('cloud', { EVAL_PROVIDER: 'openai', OPENAI_API_KEY: 'k' });
    expect(s).toMatchObject({ provider: 'openai', openaiApiKey: 'k', localChunkSize: 0 });
    expect(buildSettings('cloud', {}).provider).toBe('anthropic');
  });

  it('refuses a local provider on the cloud tier', () => {
    expect(() => buildSettings('cloud', { EVAL_PROVIDER: 'local' })).toThrow(/cloud/);
  });

  it('labels the model without exposing keys', () => {
    const s = buildSettings('cloud', { EVAL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'secret', EVAL_ANTHROPIC_MODEL: 'claude-x' });
    expect(modelLabel(s)).toBe('anthropic/claude-x');
    expect(modelLabel(s)).not.toContain('secret');
  });
});

describe('installCallCounter', () => {
  it('counts POST requests and restores fetch', async () => {
    const calls: string[] = [];
    const target = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(init?.method)); return new Response('{}'); }) as typeof fetch };
    const original = target.fetch;
    const counter = installCallCounter(target);
    await target.fetch('http://x', { method: 'POST' });
    await target.fetch('http://x', { method: 'GET' });
    await target.fetch(new Request('http://x', { method: 'POST' }));
    expect(counter.count()).toBe(2);
    counter.reset();
    expect(counter.count()).toBe(0);
    counter.restore();
    expect(target.fetch).toBe(original);
    expect(calls).toHaveLength(3);
  });
});

describe('baselineCrew', () => {
  it('matches useAnalysis.ts: no consistency agent for grants', () => {
    expect(baselineCrew('grant')).toEqual(['editor', 'reviewer-2', 'researcher', 'statistician']);
    expect(baselineCrew('manuscript')).toEqual(['editor', 'reviewer-2', 'researcher', 'statistician', 'consistency']);
  });
});
