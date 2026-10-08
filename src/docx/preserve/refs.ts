import type { JSONContent } from '@tiptap/core';
import type { PreservationStore } from './types';

export function collectFragmentIds(doc: JSONContent): Set<string> {
  const ids = new Set<string>();
  const walk = (n: JSONContent) => {
    // an image keeps the run it was read from (empty for an image the author inserted)
    if ((n.type === 'opaqueInline' || n.type === 'opaqueBlock' || n.type === 'resizableImage') && typeof n.attrs?.fragmentId === 'string' && n.attrs.fragmentId) {
      ids.add(n.attrs.fragmentId);
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return ids;
}

export function pruneFragments(store: PreservationStore, referenced: Set<string>): PreservationStore {
  const fragments: PreservationStore['fragments'] = {};
  for (const [id, f] of Object.entries(store.fragments)) if (referenced.has(id)) fragments[id] = f;
  return { ...store, fragments };
}
