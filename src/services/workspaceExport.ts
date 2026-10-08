import type { HistoryItem } from '../types';
import { stripAssetImageData } from '../db/assetStore';

/** History HTML is inlined (images as data: URLs) only while the workspace JSON stays under this many characters. */
export const WORKSPACE_HISTORY_BUDGET = 50 * 1024 * 1024;

export const HISTORY_IMAGES_OMITTED_NOTE =
  'Images were omitted from older history entries to keep this file small; their data-asset-id attributes are kept but the image bytes are not.';

/**
 * Serialise a workspace (compact JSON). `rest` (including the already self-contained `content`) is always
 * written in full. History items are inlined sequentially, newest first, while the accumulated JSON stays
 * under `budget`; older items beyond it keep their text but lose image data, and a note field records that.
 */
export async function buildWorkspaceJson(
  rest: Record<string, unknown>,
  history: HistoryItem[],
  inline: (html: string) => Promise<string>,
  budget: number = WORKSPACE_HISTORY_BUDGET,
): Promise<string> {
  let used = JSON.stringify(rest).length;
  let omitted = false;
  const out: HistoryItem[] = new Array(history.length);
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    let item: HistoryItem;
    if (used < budget) {
      item = { ...h, oldContent: await inline(h.oldContent), newContent: await inline(h.newContent) };
    } else {
      const oldContent = stripAssetImageData(h.oldContent);
      const newContent = stripAssetImageData(h.newContent);
      if (oldContent !== h.oldContent || newContent !== h.newContent) omitted = true;
      item = { ...h, oldContent, newContent };
    }
    used += item.oldContent.length + item.newContent.length;
    out[i] = item;
  }
  return JSON.stringify({ ...rest, history: out, ...(omitted ? { historyNote: HISTORY_IMAGES_OMITTED_NOTE } : {}) });
}
