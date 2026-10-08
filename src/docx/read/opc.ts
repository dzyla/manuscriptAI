/**
 * Safe resolution of OPC relationship targets to part names. DocxPackage looks parts up literally
 * (no percent-decoding, no `..` handling), so a target taken from a .rels file must be normalised
 * here, and must never be able to climb out of the package root.
 */
import type { DocxPackage } from './package';

/**
 * Resolve `target` (as written in a relationship of `sourcePart`; `''` for the package itself) to a
 * package part name. Returns undefined for anything that is not a plain internal part reference:
 * URL schemes, paths that climb above the package root, NULs, and empty or `.`-only paths.
 */
export function resolveRelTarget(sourcePart: string, target: string): string | undefined {
  if (!target || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//')) return undefined;
  let path = target.replace(/[?#].*$/, '');
  try {
    path = decodeURIComponent(path); // targets are URI references; decode BEFORE looking at segments so %2e%2e cannot hide a `..`
  } catch {
    return undefined;
  }
  path = path.replace(/\\/g, '/');
  if (path.includes('\0')) return undefined;
  const segs: string[] = path.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0) return undefined; // escapes the package root
      segs.pop();
    } else segs.push(seg);
  }
  return segs.length ? segs.join('/') : undefined;
}

/**
 * Part names reachable from `fromPart` by an internal relationship whose type ends in `/<typeSuffix>`.
 * A malformed, empty or deferred `.rels` part yields no candidates (callers fall back to the
 * conventional part name) rather than failing the import.
 */
export function relatedParts(pkg: DocxPackage, fromPart: string, typeSuffix: string): string[] {
  let rels;
  try {
    rels = pkg.rels(fromPart);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rel of rels.values()) {
    if (rel.targetMode === 'External' || !rel.type.endsWith(`/${typeSuffix}`)) continue;
    const part = resolveRelTarget(fromPart, rel.target);
    if (part !== undefined) out.push(part);
  }
  return out;
}

/** The main document part: the package's officeDocument relationship, else the conventional path. */
export function mainDocumentPart(pkg: DocxPackage): string {
  return relatedParts(pkg, '', 'officeDocument')[0] ?? 'word/document.xml';
}
