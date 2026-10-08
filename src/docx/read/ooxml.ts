/** Shared OOXML namespaces and tiny DOM helpers for the body readers (no DOM globals: runs in a worker). */
export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export function childElements(parent: Element): Element[] {
  const out: Element[] = [];
  for (let c = parent.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
}

export const isW = (el: Element, local: string): boolean => el.namespaceURI === W_NS && el.localName === local;

export const wAttr = (el: Element, name: string): string | undefined =>
  el.hasAttributeNS(W_NS, name) ? el.getAttributeNS(W_NS, name) : undefined;

export function firstW(parent: Element, local: string): Element | undefined {
  for (let c = parent.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && isW(c as Element, local)) return c as Element;
  return undefined;
}

/** OOXML on/off element: absent w:val means true. Unrecognised values read as true (the element is present). */
export function onOff(el: Element): boolean {
  const v = wAttr(el, 'val')?.trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off');
}

export const int = (s: string | undefined): number | undefined =>
  s !== undefined && /^-?\d+$/.test(s.trim()) ? Number(s) : undefined;

export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
