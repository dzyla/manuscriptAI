import { childElements, firstW, isW, wAttr } from './ooxml';

/** Google Docs tags every wrapper `goog_rdk_<n>`. They carry no content of their own. */
export function isGoogleSdt(el: Element): boolean {
  if (!isW(el, 'sdt')) return false;
  const pr = firstW(el, 'sdtPr');
  const tag = pr && firstW(pr, 'tag');
  return !!tag && (wAttr(tag, 'val') ?? '').startsWith('goog_rdk');
}

/**
 * The children of a Google Docs w:sdt's w:sdtContent, with any Google wrappers nested inside it
 * unwrapped too (any depth). `onUnwrap` is called once per wrapper removed, the outer one included.
 * Any other w:sdt stays in the list as an opaque element. A wrapper without sdtContent yields [].
 */
export function unwrapGoogleSdt(el: Element, onUnwrap?: () => void): Element[] {
  onUnwrap?.();
  const content = firstW(el, 'sdtContent');
  const out: Element[] = [];
  if (!content) return out;
  for (const child of childElements(content)) {
    if (isGoogleSdt(child)) out.push(...unwrapGoogleSdt(child, onUnwrap));
    else out.push(child);
  }
  return out;
}
