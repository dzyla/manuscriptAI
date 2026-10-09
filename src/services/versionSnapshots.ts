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
