import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { REL_NS, type Fragment } from './types';

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

/** After index `i`, only whitespace, comments and processing instructions are allowed. */
function onlyMiscAfter(src: string, i: number): boolean {
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++;
    else if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else return false;
  }
  return true;
}

function rootIsClosed(src: string, root: Element): boolean {
  const close = src.lastIndexOf(`</${root.nodeName}`);
  if (close >= 0) {
    let i = close + 2 + root.nodeName.length;
    while (/\s/.test(src[i] ?? '')) i++;
    return src[i] === '>' && onlyMiscAfter(src, i + 1);
  }
  // Self-closed root (`<a/>`): it can have no children.
  if (root.firstChild) return false;
  const start = src.indexOf(`<${root.nodeName}`);
  const end = start < 0 ? -1 : src.indexOf('/>', start);
  return end >= 0 && onlyMiscAfter(src, end + 2);
}

/**
 * Parse untrusted XML or throw. xmldom is lenient by default (a truncated document parses to a
 * partial tree and only logs a warning), so every warning/error is fatal here, DTDs/entity
 * declarations are refused outright (OOXML never needs them), and the root element must be
 * closed by the end of the source. Throws a plain Error; callers map it to their own error type.
 *
 * The DTD guard is a raw-source regex, so it also rejects a literal `<!DOCTYPE`/`<!ENTITY` that sits
 * inside a CDATA section or comment. That is an accepted false positive: Word never writes one.
 */
export function parseXmlStrict(xml: string): Document {
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new Error('DTD and entity declarations are not allowed');
  const problems: string[] = [];
  const record = (level: string) => (msg: string) => problems.push(`${level}: ${String(msg).trim()}`);
  let doc: Document | undefined;
  try {
    doc = new DOMParser({
      errorHandler: { warning: record('warning'), error: record('error'), fatalError: record('fatal') },
    }).parseFromString(src, 'text/xml') as unknown as Document;
  } catch (e) {
    throw new Error(`XML parse failed: ${(e as Error).message}`);
  }
  const root = doc?.documentElement;
  if (!root) throw new Error('XML has no root element');
  if (problems.length) throw new Error(`malformed XML (${problems[0]})`);
  // xmldom does not notice elements left open at end of input: require the root to be closed, and
  // nothing but whitespace, comments and processing instructions to follow it.
  if (!rootIsClosed(src, root)) throw new Error('XML is truncated: the root element is not closed');
  return doc;
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

/** Prefixes used by element and attribute names under `el` ('' = the default namespace), plus mc:Ignorable tokens. */
function usedPrefixes(el: Element, out: Set<string>): void {
  out.add(el.prefix || '');
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
    if (a.prefix) out.add(a.prefix);
    if (a.localName === 'Ignorable') for (const t of a.value.split(/\s+/)) if (t) out.add(t);
  }
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) usedPrefixes(c as Element, out);
}

/**
 * Declare on `root` exactly the in-scope namespaces (as seen from `scope`) that the subtree under
 * `root` uses, so the serialized subtree re-parses on its own without carrying the ~30 declarations
 * of a Word part's root. Returns the declarations added.
 */
function declareUsedNamespaces(root: Element, scope: Element): Record<string, string> {
  const used = new Set<string>();
  usedPrefixes(root, used);
  const inScope = inScopeNamespaces(scope);
  const declared: Record<string, string> = {};
  for (const prefix of used) {
    const uri = inScope[prefix];
    if (uri === undefined) continue; // undeclared, or declared inside the fragment itself
    const name = prefix ? `xmlns:${prefix}` : 'xmlns';
    // Declare via the xmlns namespace: xmldom's serializer otherwise emits a second, duplicate declaration.
    if (!root.hasAttribute(name)) root.setAttributeNS(XMLNS_NS, name, uri);
    declared[prefix] = uri;
  }
  return declared;
}

/**
 * Serialize `el` as a self-contained fragment declaring only the namespaces it uses. This is
 * persisted once per paragraph/table, so it must not carry every declaration in scope.
 */
export function captureFragment(el: Element): Fragment {
  const clone = el.cloneNode(true) as Element;
  const nsDecls = declareUsedNamespaces(clone, el);
  return { xml: serializeXml(clone), relIds: collectRelIds(el), nsDecls };
}

/**
 * Serialize `container` (attributes included) holding ONLY the given child elements, as a
 * self-contained fragment string: it declares just the namespaces the fragment actually uses (a Word
 * styles.xml has ~30 in scope; re-declaring them all on every preserved string would bloat storage),
 * so it re-parses on its own. Used to keep the part of a property container (w:pPr, w:rPr, w:style)
 * the app does not model, verbatim.
 */
export function captureChildren(container: Element, keep: Element[]): string {
  return captureShell(container, keep).xml;
}

/**
 * captureChildren as a Fragment: `container` (attributes included) holding only the `keep` elements,
 * with the relationship ids they use. Lets an opaque child of a w:r travel with the run's w:rPr
 * (a footnote reference without its superscript style would export as a plain digit).
 */
export function captureShell(container: Element, keep: Element[]): Fragment {
  const shell = container.cloneNode(false) as Element;
  for (const k of keep) shell.appendChild(k.cloneNode(true));
  const nsDecls = declareUsedNamespaces(shell, container);
  return { xml: serializeXml(shell), relIds: collectRelIds(shell), nsDecls };
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

export { collectFragmentIds, pruneFragments } from './refs';
