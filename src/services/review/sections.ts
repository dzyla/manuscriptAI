/**
 * Split a document into reviewable sections by its headings. Pure: takes a ProseMirror doc, returns ranges and text.
 * A section is a heading plus the blocks up to the next heading of ANY level, so sections never overlap; nesting is
 * carried by the key (the heading path) and by kind inheritance. Only top-level blocks are considered: a heading
 * inside a table cell is not a section boundary.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import { formatCitationGroup } from '../../utils/citationFormat';
import type { DocType, Section, SectionKind } from './types';

const REFERENCES = /^(references?( and notes)?|references cited|bibliography|literature cited|works cited)$/;

const GRANT_TABLE: [RegExp, SectionKind][] = [
  [/^(project )?summary( \/ abstract)?$|^(project )?abstract$/, 'summary'],
  [/^(project )?narrative$|^public health relevance( statement)?$/, 'narrative'],
  [/^(specific|research) aims?\b/, 'aims'],
  [/^research (strategy|plan)$/, 'strategy'],
  [/^(background and )?significance\b|^background$/, 'significance'],
  // Real grants (incl. non-NIH forms) name the same parts differently; see review-v2 design 3.1.
  [/^current state of (the )?(research|art)|^scientific premise|^current gaps|^gaps? in |^medical need|^relevance and impact|^(relevance|impact)$/, 'significance'],
  [/^innovation\b/, 'innovation'],
  [/^(research )?approach\b|^preliminary (data|studies|results)\b|^research design( and methods)?\b/, 'approach'],
  // Parts of the research plan. Career development, acknowledgements and the like deliberately stay unmatched.
  [
    /^current state of (your|our) own research|^(your|our) own (research|work)|^detailed research plan|^(schedule|timelines?|time ?line|work ?plan)\b|\bmilestones?$|^scientific rigor|^rigor\b|^rationale\b|^strategy and plan|^anticipated results|\bpitfalls\b|^alternative (strategies|approaches)|^project \d|^reason for the choice of research institution|^(research )?(environment|resources)\b|\b(immunogenicity|characterization|characterisation|in mice|in vivo|in vitro|administration|stability testing|methodology|experimental design)\b/,
    'approach',
  ],
];

const MANUSCRIPT_TABLE: [RegExp, SectionKind][] = [
  [/^abstract$|^summary$/, 'abstract'],
  [/^introduction$|^background$/, 'introduction'],
  [/^(materials and |experimental )?methods?$|^methods and materials$|^experimental (procedures|section)$|^star methods$/, 'methods'],
  [/^results( and discussion)?$/, 'results'],
  [/^discussion$|^conclusions?$|^discussion and conclusions?$/, 'discussion'],
];

/** Lowercase, fold diacritics and '&', strip outline numbering ("C.2 ", "A. ", "1 ", "IV) "). */
export function normalizeHeading(title: string): string {
  return title
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^(?:(?:[a-z]|[ivx]+|\d+)(?:\.\d+)+[.):]?\s+|(?:[a-z]|[ivx]+|\d+)[.):]\s+|[a-z]\d+(?:\.\d+)*[a-z]?[.):]?\s+|\d+\s+)/, '')
    .replace(/&/g, ' and ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The kind a heading names on its own, or null when the heading is not a known section name. */
export function classifyHeading(title: string, doc: DocType): SectionKind | null {
  const t = normalizeHeading(title);
  if (REFERENCES.test(t)) return 'references';
  for (const [re, kind] of doc === 'grant' ? GRANT_TABLE : MANUSCRIPT_TABLE) if (re.test(t)) return kind;
  return null;
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'section';
}

/** A specific parent wins; under Research Strategy or unknown content the child's own keyword decides. */
function resolveKind(own: SectionKind | null, parent: SectionKind | undefined): SectionKind {
  if (own === 'references') return own;
  if (parent && parent !== 'any' && parent !== 'strategy') return parent;
  return own ?? parent ?? 'any';
}

function blockText(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n\n', leaf => {
    if (leaf.type.name === 'citation') return formatCitationGroup((leaf.attrs.nums as number[]) ?? []);
    if (leaf.type.name === 'hardBreak') return '\n';
    return '';
  });
}

function blocksText(blocks: { node: PMNode }[]): string {
  return blocks.map(b => blockText(b.node)).filter(t => t.trim() !== '').join('\n\n');
}

export function sectionMap(doc: PMNode, docType: DocType): Section[] {
  const blocks: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, offset) => blocks.push({ node, pos: offset }));
  const end = doc.content.size;
  const headings = blocks.map((b, i) => (b.node.type.name === 'heading' ? i : -1)).filter(i => i >= 0);

  if (headings.length === 0) {
    return [{ key: 'document', kind: 'any', title: '', level: 0, from: 0, to: end, headingFrom: 0, headingTo: 0, text: blocksText(blocks) }];
  }

  const out: Section[] = [];
  const preText = blocksText(blocks.slice(0, headings[0]));
  if (preText.trim()) {
    out.push({ key: 'preamble', kind: 'any', title: '', level: 0, from: 0, to: blocks[headings[0]].pos, headingFrom: 0, headingTo: 0, text: preText });
  }

  const stack: { level: number; slug: string; kind: SectionKind }[] = [];
  const seen = new Map<string, number>();
  headings.forEach((hi, n) => {
    const heading = blocks[hi];
    const level = Number(heading.node.attrs.level) || 1;
    const title = heading.node.textContent.trim();
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    const kind = resolveKind(classifyHeading(title, docType), parent?.kind);
    const slug = slugify(title);
    const path = [...stack.map(s => s.slug), slug].join('/');
    const count = seen.get(path) ?? 0;
    seen.set(path, count + 1);
    stack.push({ level, slug, kind });

    const nextIdx = n + 1 < headings.length ? headings[n + 1] : blocks.length;
    out.push({
      key: `${path}#${count}`,
      kind,
      title,
      level,
      from: heading.pos,
      to: nextIdx < blocks.length ? blocks[nextIdx].pos : end,
      headingFrom: heading.pos,
      headingTo: heading.pos + heading.node.nodeSize,
      text: blocksText(blocks.slice(hi + 1, nextIdx)),
    });
  });
  return out;
}
