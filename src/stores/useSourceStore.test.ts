import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useSourceStore, flushPersist } from './useSourceStore';
import type { ManuscriptSource } from '../types';

const src = (id: string): ManuscriptSource => ({ id, name: id, type: 'text', text: 'x' });
/** Waits on the queue AND on real time, so the assertion does not depend on the mechanism under test knowing about flushPersist. */
const quiesce = async () => { await flushPersist(); await new Promise(r => setTimeout(r, 100)); };
const stored = async () => (await db.sources.orderBy('order').toArray()).map(r => r.id);

beforeEach(async () => { await flushPersist(); await db.sources.clear(); useSourceStore.setState({ sources: [] }); });

describe('useSourceStore persistence', () => {
  it('add then remove leaves the database empty, not holding the removed source', async () => {
    useSourceStore.getState().addSources([src('X')]);
    useSourceStore.getState().removeSource('X'); // no await between them
    await quiesce();
    expect(useSourceStore.getState().sources).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('add A, add B, remove A leaves exactly B', async () => {
    const s = useSourceStore.getState();
    s.addSources([src('A')]); s.addSources([src('B')]); s.removeSource('A'); // no await between them: the interleaving that lost data
    await quiesce();
    expect(await stored()).toEqual(['B']);
  });

  it('a write that fails leaves the previous contents, not an empty table', async () => {
    useSourceStore.getState().addSources([src('keep')]);
    await flushPersist();
    const spy = vi.spyOn(db.sources, 'bulkPut').mockRejectedValueOnce(new Error('disk full'));
    useSourceStore.getState().addSources([src('new')]);
    await flushPersist();
    spy.mockRestore();
    expect(await stored()).toEqual(['keep']);
  });

  it('a failed persist does not stop the ones after it', async () => {
    const spy = vi.spyOn(db.sources, 'bulkPut').mockRejectedValueOnce(new Error('boom'));
    useSourceStore.getState().addSources([src('a')]);
    await flushPersist();
    spy.mockRestore();
    useSourceStore.getState().addSources([src('b')]);
    await flushPersist();
    expect(await stored()).toEqual(['a', 'b']);
  });
});
