import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { JSONContent } from '@tiptap/core';
import { REL_NS, type Fragment, type PreservationStore } from './types';

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

export function serializeXml(node: Node): string {
  return new XMLSerializer().serializeToString(node as any);
}

/** Namespace declarations in scope at `el` (nearest declaration wins). */
function inScopeNamespaces(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: Node | null = el;
  while (cur && cur.nodeType === 1) {
    const attrs = (cur as Element).attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.name === 'xmlns' && !('' in out)) out[''] = a.value;
      else if (a.name.startsWith('xmlns:')) {
        const prefix = a.name.slice(6);
        if (!(prefix in out)) out[prefix] = a.value;
      }
    }
    cur = cur.parentNode;
  }
  return out;
}

function collectRelIds(el: Element): string[] {
  const ids: string[] = [];
  const walk = (n: Element) => {
    const attrs = n.attributes;
    for (let i = 0; i < attrs.length; i++) {
      if (attrs[i].namespaceURI === REL_NS && !ids.includes(attrs[i].value)) ids.push(attrs[i].value);
    }
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) walk(c as Element);
  };
  walk(el);
  return ids;
}

/** Serialize `el` as a self-contained fragment carrying every in-scope namespace declaration. */
export function captureFragment(el: Element): Fragment {
  const nsDecls = inScopeNamespaces(el);
  const clone = el.cloneNode(true) as Element;
  for (const [prefix, uri] of Object.entries(nsDecls)) {
    const name = prefix ? `xmlns:${prefix}` : 'xmlns';
    // Declare via the xmlns namespace: xmldom's serializer otherwise emits a second, duplicate declaration.
    if (!clone.hasAttribute(name)) clone.setAttributeNS(XMLNS_NS, name, uri);
  }
  return { xml: serializeXml(clone), relIds: collectRelIds(el), nsDecls };
}

export function remapRelIds(fragment: Fragment, mapping: Record<string, string>): Fragment {
  const doc = parseXml(fragment.xml);
  const walk = (n: Element) => {
    const attrs = n.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.namespaceURI === REL_NS && mapping[a.value]) n.setAttributeNS(REL_NS, a.name, mapping[a.value]);
    }
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) walk(c as Element);
  };
  walk(doc.documentElement);
  return {
    xml: serializeXml(doc.documentElement),
    relIds: fragment.relIds.map(id => mapping[id] ?? id),
    nsDecls: fragment.nsDecls,
  };
}

/** Keep each needed id if free; otherwise assign the next unused rIdN. Returns old → new. */
export function allocateRelIds(needed: string[], taken: Set<string>): Record<string, string> {
  const used = new Set(taken);
  const out: Record<string, string> = {};
  let n = 1;
  for (const id of needed) {
    if (!taken.has(id) && !used.has(id)) {
      out[id] = id;
      used.add(id);
      continue;
    }
    while (used.has(`rId${n}`)) n++;
    out[id] = `rId${n}`;
    used.add(`rId${n}`);
  }
  return out;
}

export function collectFragmentIds(doc: JSONContent): Set<string> {
  const ids = new Set<string>();
  const walk = (n: JSONContent) => {
    if ((n.type === 'opaqueInline' || n.type === 'opaqueBlock') && typeof n.attrs?.fragmentId === 'string') {
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
