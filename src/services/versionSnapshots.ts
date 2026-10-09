import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../db/manuscriptDb';
import { inlineAssetImages } from '../db/assetStore';
import type { VersionSnapshot } from '../types';

/** Persistence and display helpers for named version snapshots, shared by the top-bar popup and the Write panel's Versions section. */
export function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function wordCount(html: string) {
  return stripHtml(html).split(/\s+/).filter(w => w.length > 0).length;
}

export function formatSnapshotDate(ts: number) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function listSnapshots(): Promise<VersionSnapshot[]> {
  return db.versionSnapshots.orderBy('timestamp').reverse().toArray();
}

export async function saveSnapshot(title: string, content: string, name: string): Promise<VersionSnapshot> {
  const snapshot: VersionSnapshot = {
    id: `snap-${Date.now()}`,
    name: name.trim() || `Snapshot — ${new Date().toLocaleString()}`,
    timestamp: Date.now(),
    title,
    // Self-contained copy: session blob: image URLs would be dead after a reload.
    content: await inlineAssetImages(content),
    wordCount: wordCount(content),
  };
  await db.versionSnapshots.put(snapshot);
  return snapshot;
}

export function deleteSnapshot(id: string) {
  return db.versionSnapshots.delete(id);
}

/** The snapshot as stored right now, or undefined if it has been deleted (from either surface). */
export function getSnapshot(id: string) {
  return db.versionSnapshots.get(id);
}

/**
 * Restore a snapshot only if it still exists: the caller's copy may be older than the table. Returns whether it was restored.
 * The record handed to `onRestore` is the one read from the table, not the caller's in-memory copy.
 */
export async function restoreIfPresent(id: string, onRestore: (s: VersionSnapshot) => void | Promise<void>): Promise<boolean> {
  const fresh = await getSnapshot(id);
  if (!fresh) return false;
  await onRestore(fresh);
  return true;
}

/** What the author is told when a restore finds its snapshot gone. */
export const SNAPSHOT_GONE_MESSAGE = 'That snapshot no longer exists, so nothing was restored. Your document is unchanged.';

/** `restoreIfPresent`, but a refusal is said aloud: the author confirmed a replace and must not be left wondering why nothing happened. */
export async function restoreOrExplain(id: string, onRestore: (s: VersionSnapshot) => void | Promise<void>): Promise<boolean> {
  const restored = await restoreIfPresent(id, onRestore);
  if (!restored) window.alert(SNAPSHOT_GONE_MESSAGE);
  return restored;
}

/** Every snapshot, newest first, kept current by Dexie's liveQuery: a save or delete from any surface shows in all of them. */
export function useSnapshots(): VersionSnapshot[] {
  const [snapshots, setSnapshots] = useState<VersionSnapshot[]>([]);
  useEffect(() => {
    const sub = liveQuery(listSnapshots).subscribe({ next: setSnapshots, error: e => console.error('Snapshot list failed', e) });
    return () => sub.unsubscribe();
  }, []);
  return snapshots;
}
