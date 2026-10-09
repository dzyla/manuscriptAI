import type { Node as PMNode } from 'prosemirror-model';
import { expandCitationNums } from '../../services/citations';

/** The H2 section called `title`: its title, then each non-empty block until the next H2, joined by blank lines. */
export function sectionText(doc: PMNode, title: string): string {
  let inSection = false;
  let stopped = false;
  const parts: string[] = [title];
  doc.descendants((node) => {
    if (stopped) return false;
    if (node.type.name === 'heading' && node.attrs.level === 2) {
      if (inSection) { stopped = true; return false; }
      if (node.textContent === title) inSection = true;
    } else if (inSection && node.isBlock && node.textContent.trim()) {
      parts.push(node.textContent);
    }
    return true;
  });
  return parts.join('\n\n');
}

/** Position of the first heading (any level) whose text is exactly `text`, or null. */
export function findHeadingPos(doc: PMNode, text: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'heading' && node.textContent === text) { found = pos; return false; }
    return true;
  });
  return found;
}

/** Position of the first citation that carries number `num`: a citation node, else a legacy plain-text `[1]`, `[1-3]` or `[1,2]` group. */
export function findCitationPos(doc: PMNode, num: number): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'citation' && ((node.attrs.nums ?? []) as number[]).includes(num)) { found = pos; return false; }
    if (node.isText && node.text) {
      const pat = /\[([\d,\-]+)\]/g;
      let m;
      while ((m = pat.exec(node.text)) !== null) {
        if (expandCitationNums(m[1]).includes(num)) { found = pos + m.index; return false; }
      }
    }
    return true;
  });
  return found;
}

/** Distinct ids, in document order, of the given node type's id list (`sourceIds` for citations) or single id (`figureId` for figure labels). */
export function idsInOrder(doc: PMNode, type: 'citation' | 'figureLabel'): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== type) return true;
    const ids: string[] = type === 'citation' ? (node.attrs.sourceIds ?? []) : [node.attrs.figureId ?? ''];
    for (const id of ids) if (id && !seen.has(id)) { seen.add(id); order.push(id); }
    return true;
  });
  return order;
}
