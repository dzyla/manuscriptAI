# A1 — Canonical Document Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ProseMirror JSON the persisted source of truth, add the per-document format model, a content-addressed image asset store, an atomic repository with backups, and the OOXML preservation primitives that A2 (DOCX interop) builds on.

**Architecture:** A shared TipTap extension list (`src/extensions/schema.ts`) defines the document schema once for the live editor and for headless conversion. A `DocumentRepository` (Dexie implementation) owns load/save: lazy v2→v3 migration (HTML → JSON, data-URL images → assets), one IndexedDB transaction per save, a 10-entry backup ring, and recovery from a corrupt row. The Zustand store keeps `docJson` (always produced by the editor) plus a *derived, never persisted* HTML `content` used as a transitional command channel by existing App code until sub-project B rewrites those paths.

**Tech Stack:** TypeScript 5.8, React 19, TipTap 3.21 (`@tiptap/core` `generateJSON`/`generateHTML`/`getSchema`), Dexie 4, Zustand 5, Vitest 2, `@xmldom/xmldom` (XML in workers/node), `jsdom` + `fake-indexeddb` (tests only).

**Spec:** `docs/superpowers/specs/2026-10-07-document-engine-design.md` (§1 fidelity contract, §2 canonical model). Read §1–§2 before starting any task.

## Global Constraints

- Guiding principle (spec): *Editing a supported part of a collaborator's Word document must not damage unrelated content, metadata, citations, or revision history.*
- Persisted document rows store `docJson`; they never store HTML `content` after migration (spec §2.1).
- The in-memory HTML `content` in `useDocumentStore` is **derived**: it may be written by existing App code as a command to the editor, but `docJson` is only ever set from the editor (`onDocChange`) or from the repository. Never persist `content`.
- Binary data in IndexedDB is stored as `ArrayBuffer`, never `Blob` (portable structured clone in browsers, Electron and fake-indexeddb).
- Asset ids are content-addressed: `'a_' + sha256hex.slice(0, 32)`.
- All XML handling in `src/docx/**` uses `@xmldom/xmldom` (`DOMParser`, `XMLSerializer`) — never `window.DOMParser` — so the same code runs in Web Workers and Node tests.
- Default format for new documents: NIH preset (Arial 11 pt, 0.5" margins, US Letter, single spacing).
- Type-check gate: `npx tsc --noEmit` (do **not** rely on `npm run lint` output in this environment — an rtk proxy alters it). Test gate: `npx vitest run`.
- Baseline before A1: `tsc` clean, 63/63 tests pass. Every task must end with both gates green.
- Commit after each task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/document-engine`.

## Review Focus

1. **Concurrent saves** (30 s autosave firing while a manual save/migration is in flight) must not interleave or lose the newer document → Task 8 pins this with a "two overlapping saves, last write wins, both complete" test.
2. **Fresh install / no row** must load NIH defaults without errors or a spurious "recovered" toast → Task 8 + Task 9 tests.
3. **Corrupt or future-version `docJson`** (unknown node type) must not blank the editor; fall back to the newest valid backup and tell the user → Task 8 test.
4. **Legacy docs with large or duplicated data-URL images** must migrate without losing bytes and without storing duplicates → Task 7 + Task 10 tests.
5. **Copy/paste of a preserved opaque atom** must not leave two nodes sharing one fragment id (export would emit it twice with clashing relationship ids) → Task 4 test.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` (modify) | `PageSetup`, `StyleDef`, `DocFormat`, `ResolvedStyle`, `CommentThread`, v3 `DocumentRow` fields, `AssetRow`, `DocxPackageRow`, `BackupRow` |
| `src/services/formatPresets.ts` | Presets (nih/manuscript/a4), `createFormat`, `resolveStyle`, page sizes |
| `src/extensions/schema.ts` | Single schema extension list + `htmlToDoc`, `docToHtml`, `normalizeDoc`, `isValidDoc`, `getDocSchema` |
| `src/extensions/preserve/OoxmlProvenance.ts` | Global `ooxml` block attribute |
| `src/extensions/preserve/OpaqueNodes.ts` | `opaqueInline` / `opaqueBlock` atoms + duplicate-fragment guard plugin |
| `src/docx/preserve/types.ts` | `Fragment`, `PackageRel`, `PreservationStore` |
| `src/docx/preserve/hash.ts` | `stableStringify`, `blockHash`, `stampProvenance`, `isBlockUntouched` |
| `src/docx/preserve/xml.ts` | `captureFragment`, `remapRelIds`, `allocateRelIds`, `collectFragmentIds`, `pruneFragments` |
| `src/docx/fidelity.ts` | Fidelity categories, feature table, `ImportReport` helpers |
| `src/db/manuscriptDb.ts` (modify) | Dexie v3 tables; constructor takes a name |
| `src/db/assetStore.ts` | `sha256Hex`, `dataUrlToBytes`, `prepareAssets`, `hydrateAssets`, `collectAssetIds`, URL resolver |
| `src/db/documentRepository.ts` | `DocumentRepository` interface + Dexie implementation |
| `src/stores/useDocumentStore.ts` (modify) | `docJson`, `format`, `comments`, repository-backed `initialize`/`persist` |
| `src/components/Editor.tsx` (modify) | Use shared schema; `onDocChange` prop |
| `src/extensions/ResizableImage.tsx` (modify) | `assetId` attribute |
| `src/App.tsx` (modify) | Wire `onDocChange`, recovery toast |
| `src/index.css` (modify) | Opaque chip style |
| `vitest.config.ts`, `src/test/setup.ts` | Test config (fake-indexeddb) |
| `src/test/fixtures/legacyV2.ts` | Realistic legacy document fixture |
| `scripts/smoke/a1-persistence.mjs` | Playwright smoke for persistence |
| `.github/workflows/webpack.yml` (modify) | Add `tsc` + `vitest` to CI |

---

### Task 1: Format model and presets

**Files:**
- Modify: `src/types.ts` (append new types at the end of the "domain" section, before `// ─── Dexie row types`)
- Create: `src/services/formatPresets.ts`
- Test: `src/services/formatPresets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types `PageSetup`, `LineSpacing`, `StyleDef`, `FormatPreset`, `DocFormat`, `ResolvedStyle` (exported from `src/types.ts`).
  - `PAGE_SIZES_IN: Record<PageSetup['size'], { width: number; height: number }>`
  - `BUILTIN_STYLE_IDS: readonly ['normal','heading1','heading2','heading3','caption','bibliography']`
  - `createFormat(preset: Exclude<FormatPreset,'custom'>): DocFormat`
  - `resolveStyle(format: DocFormat, styleId: string | null | undefined): ResolvedStyle`

- [ ] **Step 1: Add the types to `src/types.ts`**

Insert immediately above the line `// ─── Dexie row types ───`:

```ts
// ─── Document format model (spec §2.2) ────────────────────────────────────────

export interface PageSetup {
  size: 'letter' | 'a4';
  orientation: 'portrait';
  marginsIn: { top: number; right: number; bottom: number; left: number };
}

export interface LineSpacing {
  /** 'auto' = multiple of single spacing; 'exact'/'atLeast' = points */
  rule: 'auto' | 'exact' | 'atLeast';
  value: number;
}

export interface StyleDef {
  id: string;
  name: string;
  type: 'paragraph' | 'character' | 'table' | 'numbering';
  basedOn?: string;
  next?: string;
  fontFamily?: string;
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  lineSpacing?: LineSpacing;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  indent?: { leftIn?: number; firstLineIn?: number; hangingIn?: number };
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Category-2 properties kept verbatim from styles.xml (keepNext, tabs, borders, …) */
  preserved?: { pPrXml?: string; rPrXml?: string };
}

export type FormatPreset = 'nih' | 'manuscript' | 'a4' | 'custom';

export interface DocFormat {
  page: PageSetup;
  styles: Record<string, StyleDef>;
  defaults: { fontFamily: string; fontSizePt: number };
  preset: FormatPreset;
}

/** A style with its basedOn chain and document defaults fully applied. */
export interface ResolvedStyle {
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  color: string;
  lineSpacing: LineSpacing;
  spaceBeforePt: number;
  spaceAfterPt: number;
  indent: { leftIn: number; firstLineIn: number; hangingIn: number };
  align: 'left' | 'center' | 'right' | 'justify';
}
```

- [ ] **Step 2: Write the failing test**

Create `src/services/formatPresets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createFormat, resolveStyle, PAGE_SIZES_IN, BUILTIN_STYLE_IDS } from './formatPresets';
import type { DocFormat } from '../types';

describe('createFormat', () => {
  it('NIH preset: Arial 11, 0.5in margins, letter, single spacing', () => {
    const f = createFormat('nih');
    expect(f.preset).toBe('nih');
    expect(f.page).toEqual({ size: 'letter', orientation: 'portrait', marginsIn: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } });
    expect(f.defaults).toEqual({ fontFamily: 'Arial', fontSizePt: 11 });
    expect(resolveStyle(f, 'normal').lineSpacing).toEqual({ rule: 'auto', value: 1 });
  });

  it('manuscript preset: Times New Roman 12, double spacing, 1in margins', () => {
    const f = createFormat('manuscript');
    expect(f.defaults).toEqual({ fontFamily: 'Times New Roman', fontSizePt: 12 });
    expect(f.page.marginsIn.left).toBe(1);
    expect(resolveStyle(f, 'normal').lineSpacing).toEqual({ rule: 'auto', value: 2 });
  });

  it('a4 preset uses a4 paper', () => {
    expect(createFormat('a4').page.size).toBe('a4');
    expect(PAGE_SIZES_IN.a4.width).toBeCloseTo(8.27, 2);
  });

  it('every preset defines all built-in styles', () => {
    for (const p of ['nih', 'manuscript', 'a4'] as const) {
      const f = createFormat(p);
      for (const id of BUILTIN_STYLE_IDS) expect(f.styles[id]?.id).toBe(id);
    }
  });

  it('returns independent objects (no shared mutable state)', () => {
    const a = createFormat('nih');
    a.page.marginsIn.top = 2;
    expect(createFormat('nih').page.marginsIn.top).toBe(0.5);
  });
});

describe('resolveStyle', () => {
  it('heading inherits font family from normal and sets bold', () => {
    const r = resolveStyle(createFormat('nih'), 'heading1');
    expect(r.fontFamily).toBe('Arial');
    expect(r.bold).toBe(true);
    expect(r.fontSizePt).toBe(11);
  });

  it('unknown or empty style id resolves to normal', () => {
    const f = createFormat('nih');
    expect(resolveStyle(f, 'nope')).toEqual(resolveStyle(f, 'normal'));
    expect(resolveStyle(f, null)).toEqual(resolveStyle(f, 'normal'));
  });

  it('walks a custom basedOn chain, child overrides parent', () => {
    const f: DocFormat = createFormat('nih');
    f.styles.aimTitle = { id: 'aimTitle', name: 'Aim Title', type: 'paragraph', basedOn: 'heading2', italic: true, fontSizePt: 12 };
    const r = resolveStyle(f, 'aimTitle');
    expect(r).toMatchObject({ bold: true, italic: true, fontSizePt: 12, fontFamily: 'Arial' });
  });

  it('survives a basedOn cycle', () => {
    const f: DocFormat = createFormat('nih');
    f.styles.a = { id: 'a', name: 'A', type: 'paragraph', basedOn: 'b', bold: true };
    f.styles.b = { id: 'b', name: 'B', type: 'paragraph', basedOn: 'a', italic: true };
    const r = resolveStyle(f, 'a');
    expect(r.bold).toBe(true);
    expect(r.italic).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/services/formatPresets.test.ts`
Expected: FAIL — `Cannot find module './formatPresets'` (or similar).

- [ ] **Step 4: Implement `src/services/formatPresets.ts`**

```ts
import type { DocFormat, FormatPreset, PageSetup, ResolvedStyle, StyleDef } from '../types';

export const PAGE_SIZES_IN: Record<PageSetup['size'], { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  a4: { width: 8.27, height: 11.69 },
};

export const BUILTIN_STYLE_IDS = ['normal', 'heading1', 'heading2', 'heading3', 'caption', 'bibliography'] as const;

interface PresetSpec {
  size: PageSetup['size'];
  marginIn: number;
  fontFamily: string;
  fontSizePt: number;
  lineMultiple: number;
}

const PRESETS: Record<Exclude<FormatPreset, 'custom'>, PresetSpec> = {
  nih: { size: 'letter', marginIn: 0.5, fontFamily: 'Arial', fontSizePt: 11, lineMultiple: 1 },
  manuscript: { size: 'letter', marginIn: 1, fontFamily: 'Times New Roman', fontSizePt: 12, lineMultiple: 2 },
  a4: { size: 'a4', marginIn: 1, fontFamily: 'Arial', fontSizePt: 11, lineMultiple: 1 },
};

function builtinStyles(spec: PresetSpec): Record<string, StyleDef> {
  const s: StyleDef[] = [
    {
      id: 'normal', name: 'Normal', type: 'paragraph',
      fontFamily: spec.fontFamily, fontSizePt: spec.fontSizePt,
      lineSpacing: { rule: 'auto', value: spec.lineMultiple },
      spaceBeforePt: 0, spaceAfterPt: 0, align: 'left',
    },
    { id: 'heading1', name: 'Heading 1', type: 'paragraph', basedOn: 'normal', next: 'normal', bold: true, spaceBeforePt: 6, spaceAfterPt: 3 },
    { id: 'heading2', name: 'Heading 2', type: 'paragraph', basedOn: 'normal', next: 'normal', bold: true, spaceBeforePt: 6, spaceAfterPt: 3 },
    { id: 'heading3', name: 'Heading 3', type: 'paragraph', basedOn: 'normal', next: 'normal', bold: true, italic: true, spaceBeforePt: 3, spaceAfterPt: 0 },
    { id: 'caption', name: 'Caption', type: 'paragraph', basedOn: 'normal', fontSizePt: Math.max(spec.fontSizePt - 1, 9), spaceAfterPt: 3 },
    { id: 'bibliography', name: 'Bibliography', type: 'paragraph', basedOn: 'normal', indent: { hangingIn: 0.25 } },
  ];
  return Object.fromEntries(s.map(x => [x.id, x]));
}

export function createFormat(preset: Exclude<FormatPreset, 'custom'>): DocFormat {
  const spec = PRESETS[preset];
  const m = spec.marginIn;
  return {
    page: { size: spec.size, orientation: 'portrait', marginsIn: { top: m, right: m, bottom: m, left: m } },
    styles: builtinStyles(spec),
    defaults: { fontFamily: spec.fontFamily, fontSizePt: spec.fontSizePt },
    preset,
  };
}

/** Collect the basedOn chain from root ancestor to the style itself (cycle-safe). */
function styleChain(format: DocFormat, styleId: string): StyleDef[] {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  let cur: StyleDef | undefined = format.styles[styleId];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.basedOn ? format.styles[cur.basedOn] : undefined;
  }
  return chain;
}

export function resolveStyle(format: DocFormat, styleId: string | null | undefined): ResolvedStyle {
  const id = styleId && format.styles[styleId] ? styleId : 'normal';
  const base: ResolvedStyle = {
    fontFamily: format.defaults.fontFamily,
    fontSizePt: format.defaults.fontSizePt,
    bold: false,
    italic: false,
    color: '#000000',
    lineSpacing: { rule: 'auto', value: 1 },
    spaceBeforePt: 0,
    spaceAfterPt: 0,
    indent: { leftIn: 0, firstLineIn: 0, hangingIn: 0 },
    align: 'left',
  };
  const chain = id === 'normal' ? styleChain(format, 'normal') : styleChain(format, id);
  // Ensure 'normal' is the implicit root for paragraph styles without an explicit basedOn chain to it.
  if (id !== 'normal' && chain[0]?.id !== 'normal' && format.styles.normal) chain.unshift(format.styles.normal);
  for (const s of chain) {
    if (s.fontFamily !== undefined) base.fontFamily = s.fontFamily;
    if (s.fontSizePt !== undefined) base.fontSizePt = s.fontSizePt;
    if (s.bold !== undefined) base.bold = s.bold;
    if (s.italic !== undefined) base.italic = s.italic;
    if (s.color !== undefined) base.color = s.color;
    if (s.lineSpacing !== undefined) base.lineSpacing = { ...s.lineSpacing };
    if (s.spaceBeforePt !== undefined) base.spaceBeforePt = s.spaceBeforePt;
    if (s.spaceAfterPt !== undefined) base.spaceAfterPt = s.spaceAfterPt;
    if (s.indent) base.indent = { ...base.indent, ...s.indent };
    if (s.align !== undefined) base.align = s.align;
  }
  return base;
}
```

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run src/services/formatPresets.test.ts && npx tsc --noEmit`
Expected: all tests PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/services/formatPresets.ts src/services/formatPresets.test.ts
git commit -m "feat(a1): document format model and NIH/manuscript/A4 presets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared schema, headless converters, test environment

**Files:**
- Modify: `package.json` (devDependencies: `jsdom`, `fake-indexeddb`; dependency: `@xmldom/xmldom`)
- Create: `vitest.config.ts`, `src/test/setup.ts`
- Create: `src/extensions/schema.ts`
- Modify: `src/components/Editor.tsx:1-30` (imports) and `:200-219` (extensions array)
- Test: `src/extensions/schema.test.ts`

**Interfaces:**
- Consumes: existing `ResizableImage`, `CitationNode`, `FigureLabel` extensions.
- Produces (from `src/extensions/schema.ts`):
  - `getSchemaExtensions(): Extensions` — the document schema; Tasks 3, 4, 7 add entries to it.
  - `getDocSchema(): Schema` (memoized)
  - `htmlToDoc(html: string): JSONContent` (requires a DOM: browser or jsdom)
  - `docToHtml(doc: JSONContent): string`
  - `normalizeDoc(doc: JSONContent): JSONContent` — round-trips through the PM schema so defaults/mark order are canonical; throws on invalid content
  - `isValidDoc(doc: unknown): doc is JSONContent`

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install --save @xmldom/xmldom@^0.8.11
npm install --save-dev jsdom@25.0.1 fake-indexeddb@6.0.0
```
Expected: installs succeed; `package.json` lists them.

- [ ] **Step 2: Create `vitest.config.ts`**

(A standalone config keeps the Electron Vite plugin out of the test run.)

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Create `src/test/setup.ts`**

```ts
// Global IndexedDB implementation for Dexie-backed tests (harmless for pure tests).
import 'fake-indexeddb/auto';
```

- [ ] **Step 4: Run the existing suite to confirm nothing regressed**

Run: `npx vitest run`
Expected: `63 passed`.

- [ ] **Step 5: Write the failing test**

Create `src/extensions/schema.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { htmlToDoc, docToHtml, normalizeDoc, isValidDoc, getDocSchema } from './schema';

const SAMPLE = [
  '<h2>Specific Aims</h2>',
  '<p style="text-align: justify">Text with <strong>bold</strong>, <em>italic</em>, <u>underline</u>, ',
  '<a href="https://example.org">a link</a> and a citation ',
  '<span data-citation-node="" data-source-ids="s1,s2" data-nums="1,2">[1,2]</span>.</p>',
  '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul>',
  '<ol><li><p>first</p></li></ol>',
  '<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>c</p></td></tr></tbody></table>',
  '<blockquote><p>quote</p></blockquote>',
].join('');

describe('schema converters', () => {
  it('html → doc → html → doc is a fixed point', () => {
    const a = htmlToDoc(SAMPLE);
    const b = htmlToDoc(docToHtml(a));
    expect(b).toEqual(a);
  });

  it('keeps citation attributes', () => {
    const doc = htmlToDoc(SAMPLE);
    const json = JSON.stringify(doc);
    expect(json).toContain('"sourceIds":["s1","s2"]');
    expect(json).toContain('"nums":[1,2]');
  });

  it('keeps nested lists and table headers', () => {
    const doc = htmlToDoc(SAMPLE);
    const json = JSON.stringify(doc);
    expect(json).toContain('"tableHeader"');
    expect((json.match(/"bulletList"/g) ?? []).length).toBe(2);
  });

  it('normalizeDoc fills attribute defaults and is idempotent', () => {
    const raw = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] };
    const n = normalizeDoc(raw);
    expect(normalizeDoc(n)).toEqual(n);
    expect(n.content?.[0].attrs).toBeDefined();
  });

  it('isValidDoc rejects unknown node types and non-docs', () => {
    expect(isValidDoc({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
    expect(isValidDoc({ type: 'doc', content: [{ type: 'hologram' }] })).toBe(false);
    expect(isValidDoc(null)).toBe(false);
    expect(isValidDoc({ type: 'paragraph' })).toBe(false);
  });

  it('schema contains the app node types', () => {
    const s = getDocSchema();
    for (const n of ['doc', 'paragraph', 'heading', 'table', 'citation', 'figureLabel', 'resizableImage'])
      expect(s.nodes[n], n).toBeDefined();
  });
});
```

Note: if the image node's registered name is not `resizableImage`, check `src/extensions/ResizableImage.tsx` (`name:` field) and use that exact name in the test.

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/extensions/schema.test.ts`
Expected: FAIL — cannot find module `./schema`.

- [ ] **Step 7: Implement `src/extensions/schema.ts`**

TipTap 3's StarterKit already includes `Link` and `Underline`; the current Editor registers them twice. The shared list configures them through StarterKit instead.

```ts
import { generateHTML, generateJSON, getSchema, type Extensions, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import { ResizableImage } from './ResizableImage';
import { CitationNode } from './CitationNode';
import { FigureLabel } from './FigureLabel';

/**
 * The document schema, shared by the live editor and headless conversion.
 * Interactive-only extensions (placeholder, autocomplete, grammar) are added by Editor.tsx.
 */
export function getSchemaExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false },
    }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TableKit.configure({ table: { resizable: true } }),
    ResizableImage,
    CitationNode,
    FigureLabel,
  ];
}

let schemaCache: Schema | null = null;
let extCache: Extensions | null = null;

function exts(): Extensions {
  if (!extCache) extCache = getSchemaExtensions();
  return extCache;
}

export function getDocSchema(): Schema {
  if (!schemaCache) schemaCache = getSchema(exts());
  return schemaCache;
}

/** Parse HTML into canonical document JSON. Needs a DOM (browser or jsdom). */
export function htmlToDoc(html: string): JSONContent {
  return normalizeDoc(generateJSON(html, exts()) as JSONContent);
}

export function docToHtml(doc: JSONContent): string {
  return generateHTML(doc, exts());
}

/** Round-trip through the ProseMirror schema: fills defaults, canonical mark order. Throws if invalid. */
export function normalizeDoc(doc: JSONContent): JSONContent {
  const node = getDocSchema().nodeFromJSON(doc);
  node.check();
  return node.toJSON() as JSONContent;
}

export function isValidDoc(doc: unknown): doc is JSONContent {
  if (!doc || typeof doc !== 'object' || (doc as JSONContent).type !== 'doc') return false;
  try {
    normalizeDoc(doc as JSONContent);
    return true;
  } catch {
    return false;
  }
}
```

If `@tiptap/pm/model` is not resolvable, import the type from `prosemirror-model` (already used by `src/components/Editor.tsx` via `prosemirror-state`).

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/extensions/schema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Switch `Editor.tsx` to the shared schema**

In `src/components/Editor.tsx`:
- Remove imports of `StarterKit`, `Highlight`, `Underline`, `TextAlign`, `Link`, `TableKit`, `ResizableImage`, `CitationNode`, `FigureLabel` **only if** they are not referenced elsewhere in the file (search each name first; `ResizableImage`/`CitationNode` may be referenced for commands — keep those imports if so).
- Add: `import { getSchemaExtensions } from '../extensions/schema';`
- Replace the head of the `extensions: [...]` array in `useEditor` so it reads:

```ts
    extensions: [
      ...getSchemaExtensions(),
      Placeholder.configure({ placeholder: 'Start writing your manuscript here...' }),
      GrammarChecker,
      AutoComplete.configure({
        getEnabled: () => autocompleteEnabledRef.current,
        onSuggest: (contextText, signal, meta) => {
          if (!aiSettingsRef.current) return Promise.resolve('');
          return generateCompletion(contextText, aiSettingsRef.current, signal, meta?.heading);
        },
        onLoadingChange: setAutocompleteLoading,
      }),
    ],
```

- [ ] **Step 10: Run both gates**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0; all tests pass (63 + 5 + 6).

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/test/setup.ts src/extensions/schema.ts src/extensions/schema.test.ts src/components/Editor.tsx
git commit -m "feat(a1): shared document schema and headless html/json converters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Block provenance attribute and content hashing

**Files:**
- Create: `src/extensions/preserve/OoxmlProvenance.ts`
- Create: `src/docx/preserve/hash.ts`
- Modify: `src/extensions/schema.ts` (add `OoxmlProvenance` to `getSchemaExtensions()`)
- Test: `src/docx/preserve/hash.test.ts`

**Interfaces:**
- Consumes: `normalizeDoc`, `htmlToDoc`, `docToHtml` (Task 2).
- Produces:
  - `PROVENANCE_NODE_TYPES: string[]`
  - `OoxmlProvenance` extension adding attr `ooxml: { blockId: string; sourceHash: string } | null` to those node types; HTML form `data-ooxml='{"blockId":…,"sourceHash":…}'`
  - `stableStringify(value: unknown): string`
  - `blockHash(node: JSONContent): string` — hash of the node with every `ooxml` attr removed (recursively)
  - `stampProvenance(node: JSONContent, blockId: string): JSONContent` — node must already be normalized
  - `isBlockUntouched(node: JSONContent): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/docx/preserve/hash.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { stableStringify, blockHash, stampProvenance, isBlockUntouched } from './hash';
import { normalizeDoc, htmlToDoc, docToHtml } from '../../extensions/schema';

const para = (text: string): JSONContent =>
  normalizeDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }).content![0];

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('keeps array order', () => {
    expect(stableStringify([2, 1])).toBe('[2,1]');
  });
});

describe('block provenance', () => {
  it('stamped block is untouched until its content changes', () => {
    const p = stampProvenance(para('hello'), 'b1');
    expect(p.attrs?.ooxml).toEqual({ blockId: 'b1', sourceHash: blockHash(p) });
    expect(isBlockUntouched(p)).toBe(true);
    const edited = { ...p, content: [{ type: 'text', text: 'hello!' }] };
    expect(isBlockUntouched(edited)).toBe(false);
  });

  it('hash ignores the ooxml attribute itself', () => {
    const p = para('x');
    expect(blockHash(stampProvenance(p, 'b9'))).toBe(blockHash(p));
  });

  it('a block without provenance is never untouched', () => {
    expect(isBlockUntouched(para('x'))).toBe(false);
  });

  it('survives an editor-style html round trip unchanged', () => {
    const p = stampProvenance(para('round trip'), 'b2');
    const doc: JSONContent = { type: 'doc', content: [p] };
    const back = htmlToDoc(docToHtml(doc));
    expect(back.content![0].attrs?.ooxml).toEqual(p.attrs?.ooxml);
    expect(isBlockUntouched(back.content![0])).toBe(true);
  });

  it('adding a mark makes the block touched', () => {
    const p = stampProvenance(para('mark me'), 'b3');
    const bolded = { ...p, content: [{ type: 'text', text: 'mark me', marks: [{ type: 'bold' }] }] };
    expect(isBlockUntouched(normalizeDoc({ type: 'doc', content: [bolded] }).content![0])).toBe(false);
  });

  it('malformed data-ooxml in HTML parses to null', () => {
    const doc = htmlToDoc('<p data-ooxml="{not json">x</p>');
    expect(doc.content![0].attrs?.ooxml ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/docx/preserve/hash.test.ts`
Expected: FAIL — cannot find module `./hash`.

- [ ] **Step 3: Implement `src/extensions/preserve/OoxmlProvenance.ts`**

```ts
import { Extension } from '@tiptap/core';

/** Block types that can carry original-OOXML provenance (spec §2.4). */
export const PROVENANCE_NODE_TYPES = [
  'paragraph', 'heading', 'table', 'bulletList', 'orderedList', 'blockquote', 'opaqueBlock',
];

export interface OoxmlProvenanceAttr {
  blockId: string;
  sourceHash: string;
}

function parseProvenance(raw: string | null): OoxmlProvenanceAttr | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.blockId === 'string' && typeof v.sourceHash === 'string'
      ? { blockId: v.blockId, sourceHash: v.sourceHash }
      : null;
  } catch {
    return null;
  }
}

export const OoxmlProvenance = Extension.create({
  name: 'ooxmlProvenance',
  addGlobalAttributes() {
    return [
      {
        types: PROVENANCE_NODE_TYPES,
        attributes: {
          ooxml: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => parseProvenance(el.getAttribute('data-ooxml')),
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.ooxml ? { 'data-ooxml': JSON.stringify(attrs.ooxml) } : {},
          },
        },
      },
    ];
  },
});
```

`keepOnSplit: false` matters: splitting a paragraph must not give the new half the original's provenance (it would otherwise claim to be an untouched copy of the source block).

- [ ] **Step 4: Implement `src/docx/preserve/hash.ts`**

```ts
import type { JSONContent } from '@tiptap/core';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function stripProvenance(node: JSONContent): JSONContent {
  const out: JSONContent = { ...node };
  if (node.attrs && 'ooxml' in node.attrs) {
    const { ooxml: _drop, ...rest } = node.attrs;
    out.attrs = rest;
  }
  if (node.content) out.content = node.content.map(stripProvenance);
  return out;
}

/** cyrb53: fast, synchronous 53-bit string hash (collision risk negligible per block). */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function blockHash(node: JSONContent): string {
  return cyrb53(stableStringify(stripProvenance(node)));
}

/** Attach provenance. `node` must already be schema-normalized (see normalizeDoc). */
export function stampProvenance(node: JSONContent, blockId: string): JSONContent {
  return { ...node, attrs: { ...(node.attrs ?? {}), ooxml: { blockId, sourceHash: blockHash(node) } } };
}

export function isBlockUntouched(node: JSONContent): boolean {
  const p = node.attrs?.ooxml as { sourceHash?: string } | null | undefined;
  return !!p?.sourceHash && blockHash(node) === p.sourceHash;
}
```

- [ ] **Step 5: Register the extension**

In `src/extensions/schema.ts` add `import { OoxmlProvenance } from './preserve/OoxmlProvenance';` and append `OoxmlProvenance,` as the last entry of the array returned by `getSchemaExtensions()`.

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; tsc exit 0. (Schema tests from Task 2 must still pass — `ooxml: null` defaults appear identically on both sides of the round trip.)

- [ ] **Step 7: Commit**

```bash
git add src/extensions/preserve/OoxmlProvenance.ts src/docx/preserve/hash.ts src/docx/preserve/hash.test.ts src/extensions/schema.ts
git commit -m "feat(a1): block provenance attribute and content hashing for verbatim reuse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Preservation store, XML fragment helpers, opaque atoms

**Files:**
- Create: `src/docx/preserve/types.ts`, `src/docx/preserve/xml.ts`
- Create: `src/extensions/preserve/OpaqueNodes.ts`
- Modify: `src/extensions/schema.ts` (register opaque nodes), `src/index.css` (chip style)
- Test: `src/docx/preserve/xml.test.ts`, `src/extensions/preserve/OpaqueNodes.test.ts`

**Interfaces:**
- Consumes: `getSchemaExtensions`, `normalizeDoc` (Task 2).
- Produces:
  - `src/docx/preserve/types.ts`:
    ```ts
    interface Fragment { xml: string; relIds: string[]; nsDecls: Record<string, string> }
    interface PackageRel { id: string; type: string; target: string; targetMode?: 'External' }
    interface PreservationStore { version: 1; blocks: Record<string, Fragment>; fragments: Record<string, Fragment>; rels: Record<string, PackageRel> }
    function emptyPreservationStore(): PreservationStore
    const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    ```
  - `src/docx/preserve/xml.ts`:
    - `parseXml(xml: string): Document`, `serializeXml(node: Node): string`
    - `captureFragment(el: Element): Fragment`
    - `remapRelIds(fragment: Fragment, mapping: Record<string, string>): Fragment`
    - `allocateRelIds(needed: string[], taken: Set<string>): Record<string, string>`
    - `collectFragmentIds(doc: JSONContent): Set<string>`
    - `pruneFragments(store: PreservationStore, referenced: Set<string>): PreservationStore`
  - `src/extensions/preserve/OpaqueNodes.ts`:
    - `OpaqueInline`, `OpaqueBlock` nodes, attrs `{ kind: string; label: string; fragmentId: string }`
    - `OpaqueFragmentGuard` extension, option `onDuplicateFragment(fromId: string, toId: string): void`
    - `findDuplicateFragmentIds(doc: PMNode): Array<{ pos: number; fragmentId: string }>` (pure helper, exported for tests)

- [ ] **Step 1: Write the failing XML test**

Create `src/docx/preserve/xml.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml, captureFragment, remapRelIds, allocateRelIds, collectFragmentIds, pruneFragments } from './xml';
import { emptyPreservationStore } from './types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

const DOC = `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="${M}"><w:body>
<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId7"/></w:drawing></w:r>
<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p></w:body></w:document>`;

describe('captureFragment', () => {
  it('captures in-scope namespace declarations and relationship ids', () => {
    const doc = parseXml(DOC);
    const p = doc.getElementsByTagNameNS(W, 'p')[0];
    const f = captureFragment(p);
    expect(f.relIds).toEqual(['rId7']);
    expect(f.nsDecls).toMatchObject({ w: W, r: R, m: M });
    // fragment is self-contained: it re-parses on its own with namespaces resolved
    const re = parseXml(f.xml);
    expect(re.documentElement.namespaceURI).toBe(W);
    expect(re.getElementsByTagNameNS(M, 'oMath').length).toBe(1);
  });

  it('captures a leaf element (equation) with ancestor namespaces', () => {
    const doc = parseXml(DOC);
    const math = doc.getElementsByTagNameNS(M, 'oMath')[0];
    const f = captureFragment(math);
    expect(f.relIds).toEqual([]);
    expect(parseXml(f.xml).documentElement.localName).toBe('oMath');
  });
});

describe('remapRelIds / allocateRelIds', () => {
  it('rewrites relationship attributes only', () => {
    const f = captureFragment(parseXml(DOC).getElementsByTagNameNS(W, 'p')[0]);
    const g = remapRelIds(f, { rId7: 'rId12' });
    expect(g.relIds).toEqual(['rId12']);
    expect(g.xml).toContain('r:embed="rId12"');
    expect(g.xml).not.toContain('rId7');
  });

  it('keeps free ids and renames taken ones', () => {
    const m = allocateRelIds(['rId1', 'rId5'], new Set(['rId1', 'rId2']));
    expect(m.rId5).toBe('rId5');
    expect(m.rId1).not.toBe('rId1');
    expect(['rId1', 'rId2', 'rId5']).not.toContain(m.rId1);
  });
});

describe('fragment bookkeeping', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } }] },
      { type: 'opaqueBlock', attrs: { kind: 'sdt', label: 'content control', fragmentId: 'f2' } },
    ],
  };

  it('collects fragment ids at any depth', () => {
    expect([...collectFragmentIds(doc)].sort()).toEqual(['f1', 'f2']);
  });

  it('prunes unreferenced fragments only', () => {
    const s = emptyPreservationStore();
    s.fragments = { f1: { xml: '<a/>', relIds: [], nsDecls: {} }, f9: { xml: '<b/>', relIds: [], nsDecls: {} } };
    const out = pruneFragments(s, new Set(['f1']));
    expect(Object.keys(out.fragments)).toEqual(['f1']);
    expect(s.fragments.f9).toBeDefined(); // input not mutated
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/docx/preserve/xml.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/docx/preserve/types.ts`**

```ts
export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A self-contained OOXML fragment: XML with its namespace declarations and relationship deps. */
export interface Fragment {
  xml: string;
  relIds: string[];
  nsDecls: Record<string, string>;
}

export interface PackageRel {
  id: string;
  type: string;
  target: string;
  targetMode?: 'External';
}

/** Per-document preservation data (spec §2.4). Persisted in the docxPackages table. */
export interface PreservationStore {
  version: 1;
  /** blockId → original <w:p>/<w:tbl> XML, for verbatim reuse of untouched blocks */
  blocks: Record<string, Fragment>;
  /** fragmentId → opaque atom XML (equations, footnote refs, SDTs, …) */
  fragments: Record<string, Fragment>;
  /** original document.xml.rels entries, by id */
  rels: Record<string, PackageRel>;
}

export function emptyPreservationStore(): PreservationStore {
  return { version: 1, blocks: {}, fragments: {}, rels: {} };
}
```

- [ ] **Step 4: Implement `src/docx/preserve/xml.ts`**

```ts
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { JSONContent } from '@tiptap/core';
import { REL_NS, type Fragment, type PreservationStore } from './types';

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
    if (!clone.hasAttribute(name)) clone.setAttribute(name, uri);
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
```

- [ ] **Step 5: Run the XML tests**

Run: `npx vitest run src/docx/preserve/xml.test.ts`
Expected: PASS. If xmldom's `setAttributeNS` on an existing prefixed attribute creates a duplicate instead of replacing, replace the loop body with `a.value = mapping[a.value]` (xmldom `Attr.value` is writable) and re-run.

- [ ] **Step 6: Write the failing opaque-node test**

Create `src/extensions/preserve/OpaqueNodes.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { getSchemaExtensions, htmlToDoc, docToHtml } from '../schema';
import { OpaqueFragmentGuard, findDuplicateFragmentIds } from './OpaqueNodes';

const chip = (id: string) => ({ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: id } });

describe('opaque nodes', () => {
  it('round-trip through HTML with attributes intact', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a ' }, chip('f1')] }] };
    const back = htmlToDoc(docToHtml(doc));
    expect(JSON.stringify(back)).toContain('"fragmentId":"f1"');
    expect(JSON.stringify(back)).toContain('"kind":"equation"');
  });

  it('pasting a copy assigns a fresh fragment id and reports it', () => {
    const onDuplicateFragment = vi.fn();
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), OpaqueFragmentGuard.configure({ onDuplicateFragment })],
      content: { type: 'doc', content: [{ type: 'paragraph', content: [chip('f1')] }] },
    });
    // simulate paste of the same atom
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, chip('f1'));
    const ids: string[] = [];
    editor.state.doc.descendants(n => { if (n.type.name === 'opaqueInline') ids.push(n.attrs.fragmentId); });
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(onDuplicateFragment).toHaveBeenCalledWith('f1', ids.find(i => i !== 'f1'));
    expect(findDuplicateFragmentIds(editor.state.doc)).toEqual([]);
    editor.destroy();
  });
});
```

- [ ] **Step 7: Implement `src/extensions/preserve/OpaqueNodes.ts`**

```ts
import { Extension, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

const opaqueAttrs = () => ({
  kind: {
    default: 'unknown',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-kind') ?? 'unknown',
    renderHTML: (a: Record<string, unknown>) => ({ 'data-kind': a.kind }),
  },
  label: {
    default: 'object',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? 'object',
    renderHTML: (a: Record<string, unknown>) => ({ 'data-label': a.label }),
  },
  fragmentId: {
    default: '',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-fragment-id') ?? '',
    renderHTML: (a: Record<string, unknown>) => ({ 'data-fragment-id': a.fragmentId }),
  },
});

/** Category-3 inline content preserved verbatim (equations, footnote refs, unknown fields). */
export const OpaqueInline = Node.create({
  name: 'opaqueInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: opaqueAttrs,
  parseHTML: () => [{ tag: 'span[data-opaque]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-opaque': '', class: 'opaque-chip', contenteditable: 'false' }),
    String(node.attrs.label),
  ],
});

/** Category-3 block content preserved verbatim (content controls, section breaks, …). */
export const OpaqueBlock = Node.create({
  name: 'opaqueBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: opaqueAttrs,
  parseHTML: () => [{ tag: 'div[data-opaque]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-opaque': '', class: 'opaque-chip opaque-block', contenteditable: 'false' }),
    String(node.attrs.label),
  ],
});

/** Positions of the second and later occurrences of each fragmentId, in document order. */
export function findDuplicateFragmentIds(doc: PMNode): Array<{ pos: number; fragmentId: string }> {
  const seen = new Set<string>();
  const dupes: Array<{ pos: number; fragmentId: string }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'opaqueInline' && node.type.name !== 'opaqueBlock') return;
    const id = node.attrs.fragmentId as string;
    if (!id) return;
    if (seen.has(id)) dupes.push({ pos, fragmentId: id });
    else seen.add(id);
  });
  return dupes;
}

const newFragmentId = () =>
  'f_' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 16);

export interface OpaqueFragmentGuardOptions {
  /** Called when a copy received a new id; the caller clones the fragment store entry. */
  onDuplicateFragment: (fromId: string, toId: string) => void;
}

export const OpaqueFragmentGuard = Extension.create<OpaqueFragmentGuardOptions>({
  name: 'opaqueFragmentGuard',
  addOptions: () => ({ onDuplicateFragment: () => {} }),
  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      new Plugin({
        key: new PluginKey('opaqueFragmentGuard'),
        appendTransaction: (trs, _old, state) => {
          if (!trs.some(t => t.docChanged)) return null;
          const dupes = findDuplicateFragmentIds(state.doc);
          if (dupes.length === 0) return null;
          const tr = state.tr;
          for (const d of dupes) {
            const node = state.doc.nodeAt(d.pos);
            if (!node) continue;
            const toId = newFragmentId();
            tr.setNodeMarkup(d.pos, undefined, { ...node.attrs, fragmentId: toId });
            opts.onDuplicateFragment(d.fragmentId, toId);
          }
          tr.setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});
```

If `@tiptap/pm/state` / `@tiptap/pm/model` do not resolve, use `prosemirror-state` / `prosemirror-model` (both present in `node_modules`).

- [ ] **Step 8: Register nodes and style the chip**

In `src/extensions/schema.ts`: `import { OpaqueInline, OpaqueBlock } from './preserve/OpaqueNodes';` and add `OpaqueInline, OpaqueBlock,` before `OoxmlProvenance` in the returned array. (`OpaqueFragmentGuard` is NOT part of the schema list; Task 9 adds it to the live editor.)

Append to `src/index.css`:

```css
/* Preserved (read-only) OOXML content: equations, footnote refs, content controls */
.opaque-chip {
  display: inline-block;
  padding: 0 0.4em;
  margin: 0 0.1em;
  border: 1px dashed #94a3b8;
  border-radius: 4px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.85em;
  font-family: ui-sans-serif, system-ui, sans-serif;
  user-select: all;
  cursor: default;
}
.opaque-chip.opaque-block { display: block; margin: 0.25em 0; text-align: center; }
```

- [ ] **Step 9: Run gates**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; tsc exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/docx/preserve src/extensions/preserve/OpaqueNodes.ts src/extensions/preserve/OpaqueNodes.test.ts src/extensions/schema.ts src/index.css
git commit -m "feat(a1): preservation store, OOXML fragment capture/remap, opaque atoms

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Fidelity contract and import report

**Files:**
- Create: `src/docx/fidelity.ts`
- Test: `src/docx/fidelity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type FidelityCategory = 1 | 2 | 3 | 4`
  - `type FeatureKey` (union below), `FIDELITY: Record<FeatureKey, FidelityCategory>`
  - `interface ImportWarning { feature: FeatureKey | 'part'; message: string; category: FidelityCategory }`
  - `interface ImportReport { counts: Partial<Record<FeatureKey, number>>; byCategory: Record<FidelityCategory, number>; warnings: ImportWarning[]; pageCount?: number }`
  - `createReport(): ImportReport`, `recordFeature(r, key, n?)`, `addWarning(r, feature, message, category?)`, `summarizeReport(r): string`

- [ ] **Step 1: Write the failing test**

Create `src/docx/fidelity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FIDELITY, createReport, recordFeature, addWarning, summarizeReport } from './fidelity';

describe('fidelity table (spec §1)', () => {
  it('assigns the spec categories', () => {
    expect(FIDELITY.paragraph).toBe(1);
    expect(FIDELITY.trackedChange).toBe(1);
    expect(FIDELITY.floatingImageSquare).toBe(1);
    expect(FIDELITY.googleWrapper).toBe(1);
    expect(FIDELITY.floatingImageOther).toBe(2);
    expect(FIDELITY.externalCitation).toBe(2);
    expect(FIDELITY.equation).toBe(3);
    expect(FIDELITY.footnoteRef).toBe(3);
    expect(FIDELITY.activeX).toBe(4);
  });
});

describe('import report', () => {
  it('counts features per category', () => {
    const r = createReport();
    recordFeature(r, 'paragraph', 10);
    recordFeature(r, 'equation');
    expect(r.counts.paragraph).toBe(10);
    expect(r.byCategory[1]).toBe(10);
    expect(r.byCategory[3]).toBe(1);
  });

  it('category-4 features always produce a warning', () => {
    const r = createReport();
    recordFeature(r, 'activeX');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].category).toBe(4);
  });

  it('summary mentions pages, revisions, comments, preserved items, warnings', () => {
    const r = createReport();
    r.pageCount = 17;
    recordFeature(r, 'trackedChange', 32);
    recordFeature(r, 'comment', 52);
    recordFeature(r, 'equation', 2);
    addWarning(r, 'part', 'customXml/item9.xml could not be parsed');
    const s = summarizeReport(r);
    expect(s).toContain('17 pages');
    expect(s).toContain('32 tracked changes');
    expect(s).toContain('52 comments');
    expect(s).toContain('2 preserved read-only');
    expect(s).toContain('1 warning');
  });

  it('summary of an empty report is still readable', () => {
    expect(summarizeReport(createReport())).toBe('Imported document');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/docx/fidelity.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/docx/fidelity.ts`**

```ts
export type FidelityCategory = 1 | 2 | 3 | 4;

export type FeatureKey =
  // category 1 — editable, round-trippable
  | 'paragraph' | 'run' | 'paragraphStyle' | 'characterStyle' | 'heading' | 'list' | 'table'
  | 'mergedCell' | 'inlineImage' | 'floatingImageSquare' | 'caption' | 'pageBreak' | 'hyperlink'
  | 'pageSetup' | 'trackedChange' | 'formatChange' | 'comment' | 'nativeCitation' | 'googleWrapper'
  // category 2 — approximated, semantically preserved
  | 'floatingImageOther' | 'tabStops' | 'keepRules' | 'tableBorders' | 'complexNumbering' | 'externalCitation'
  | 'externalBibliography'
  // category 3 — opaque, preserved while untouched
  | 'equation' | 'footnoteRef' | 'endnoteRef' | 'contentControl' | 'bookmark' | 'unknownField'
  | 'oleObject' | 'sectionBreak'
  // category 4 — unsupported
  | 'activeX' | 'textBox' | 'smartArt';

export const FIDELITY: Record<FeatureKey, FidelityCategory> = {
  paragraph: 1, run: 1, paragraphStyle: 1, characterStyle: 1, heading: 1, list: 1, table: 1,
  mergedCell: 1, inlineImage: 1, floatingImageSquare: 1, caption: 1, pageBreak: 1, hyperlink: 1,
  pageSetup: 1, trackedChange: 1, formatChange: 1, comment: 1, nativeCitation: 1, googleWrapper: 1,
  floatingImageOther: 2, tabStops: 2, keepRules: 2, tableBorders: 2, complexNumbering: 2,
  externalCitation: 2, externalBibliography: 2,
  equation: 3, footnoteRef: 3, endnoteRef: 3, contentControl: 3, bookmark: 3, unknownField: 3,
  oleObject: 3, sectionBreak: 3,
  activeX: 4, textBox: 4, smartArt: 4,
};

const UNSUPPORTED_MESSAGE: Partial<Record<FeatureKey, string>> = {
  activeX: 'ActiveX controls are not supported and will not be exported.',
  textBox: 'Text box layout is approximated; its text was kept as plain paragraphs.',
  smartArt: 'SmartArt is not editable; it is kept only if its XML is self-contained.',
};

export interface ImportWarning {
  feature: FeatureKey | 'part';
  message: string;
  category: FidelityCategory;
}

export interface ImportReport {
  counts: Partial<Record<FeatureKey, number>>;
  byCategory: Record<FidelityCategory, number>;
  warnings: ImportWarning[];
  pageCount?: number;
}

export function createReport(): ImportReport {
  return { counts: {}, byCategory: { 1: 0, 2: 0, 3: 0, 4: 0 }, warnings: [] };
}

export function recordFeature(r: ImportReport, key: FeatureKey, n = 1): void {
  if (n <= 0) return;
  r.counts[key] = (r.counts[key] ?? 0) + n;
  const cat = FIDELITY[key];
  r.byCategory[cat] += n;
  if (cat === 4 && !r.warnings.some(w => w.feature === key)) {
    r.warnings.push({ feature: key, category: 4, message: UNSUPPORTED_MESSAGE[key] ?? `${key} is not supported.` });
  }
}

export function addWarning(r: ImportReport, feature: FeatureKey | 'part', message: string, category: FidelityCategory = 4): void {
  r.warnings.push({ feature, message, category });
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function summarizeReport(r: ImportReport): string {
  const parts: string[] = [];
  if (r.pageCount) parts.push(plural(r.pageCount, 'page'));
  const c = r.counts;
  const revisions = (c.trackedChange ?? 0) + (c.formatChange ?? 0);
  if (revisions) parts.push(plural(revisions, 'tracked change'));
  if (c.comment) parts.push(plural(c.comment, 'comment'));
  const cites = (c.nativeCitation ?? 0) + (c.externalCitation ?? 0);
  if (cites) parts.push(plural(cites, 'citation'));
  if (r.byCategory[3]) parts.push(`${r.byCategory[3]} preserved read-only`);
  if (r.warnings.length) parts.push(plural(r.warnings.length, 'warning'));
  return parts.length ? `Imported ${parts.join(' · ')}` : 'Imported document';
}
```

- [ ] **Step 4: Run gates**

Run: `npx vitest run src/docx/fidelity.test.ts && npx tsc --noEmit` → PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/docx/fidelity.ts src/docx/fidelity.test.ts
git commit -m "feat(a1): fidelity contract categories and import report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Dexie v3 schema and row types

**Files:**
- Modify: `src/types.ts` (`DocumentRow` + new row types)
- Modify: `src/db/manuscriptDb.ts`
- Test: `src/db/manuscriptDb.test.ts`

**Interfaces:**
- Consumes: `DocFormat` (Task 1), `PreservationStore` (Task 4).
- Produces:
  - `CommentThread`, `CommentReply` types (A3 extends them).
  - `DocumentRow` gains: `content?: string` (legacy only), `docJson?: JSONContent`, `format?: DocFormat`, `comments?: CommentThread[]`, `schemaVersion?: 3`.
  - `AssetRow { id: string; sha256: string; mime: string; size: number; data: ArrayBuffer; createdAt: number }`
  - `DocxPackageRow { documentId: 'current'; original: ArrayBuffer; fileName: string; preservation: PreservationStore; importedAt: number }`
  - `BackupRow { seq?: number; documentId: 'current'; savedAt: number; row: DocumentRow }`
  - `class ManuscriptDb` exported, `constructor(name = 'ManuscriptAIEditor')`; tables `assets`, `docxPackages`, `autosaveBackups`. `export const db = new ManuscriptDb()`.

Note: the existing `versionSnapshots` table holds user-named "Time Machine" snapshots; automatic backups go to the new `autosaveBackups` table so they never clutter the user's history.

- [ ] **Step 1: Update `src/types.ts`**

At the top of the file add: `import type { JSONContent } from '@tiptap/core';` and `import type { PreservationStore } from './docx/preserve/types';`

Replace the `DocumentRow` interface with:

```ts
export interface DocumentRow {
  id: 'current';
  title: string;
  /** Legacy (≤ v2) HTML body. Present only on rows not yet migrated; never written by v3 code. */
  content?: string;
  /** Canonical document (v3). */
  docJson?: JSONContent;
  format?: DocFormat;
  comments?: CommentThread[];
  schemaVersion?: 3;
  saveState: 'Draft' | 'Saved' | 'Auto-saved';
  citationRegistry: Record<string, number>;
  citationCounter: number;
  figureRegistry: Record<string, number>;
  figureCounter: number;
  updatedAt: number;
  mode?: DocumentMode;
  /** Free-text funder guidelines (FOA notes, review criteria) injected into every prompt in grant mode */
  grantInstructions?: string;
  /** id of the grant template the document was created from (enables page-budget tracking) */
  grantTemplateId?: string;
}
```

Add after it:

```ts
export interface CommentReply {
  id: string;
  author: string;
  initials?: string;
  date: string; // ISO 8601
  text: string;
}

export interface CommentThread extends CommentReply {
  replies: CommentReply[];
  resolved: boolean;
  source: 'user' | 'docx' | 'ai';
  /** anchor text was deleted; shown in the rail's "Detached" section */
  orphaned?: boolean;
  /** original Word identifiers, kept for round-trip (spec §4.4) */
  wordIds?: { id?: string; paraId?: string; durableId?: string };
}

export interface AssetRow {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  data: ArrayBuffer;
  createdAt: number;
}

export interface DocxPackageRow {
  documentId: 'current';
  original: ArrayBuffer;
  fileName: string;
  preservation: PreservationStore;
  importedAt: number;
}

export interface BackupRow {
  seq?: number;
  documentId: 'current';
  savedAt: number;
  row: DocumentRow;
}
```

- [ ] **Step 2: Fix compile errors caused by `content` becoming optional**

Run: `npx tsc --noEmit`. For each error that reads `row.content` (expected in `src/stores/useDocumentStore.ts` `initialize`), use `row.content ?? ''` for now — Task 9 replaces that code. Re-run until exit 0.

- [ ] **Step 3: Write the failing DB test**

Create `src/db/manuscriptDb.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import { ManuscriptDb } from './manuscriptDb';

describe('ManuscriptDb v3', () => {
  it('has the v3 tables', async () => {
    const db = new ManuscriptDb('t-v3-tables');
    await db.open();
    expect(db.verno).toBe(3);
    for (const t of ['documents', 'assets', 'docxPackages', 'autosaveBackups', 'versionSnapshots', 'grantTemplates'])
      expect(db.tables.map(x => x.name)).toContain(t);
    db.close();
    await Dexie.delete('t-v3-tables');
  });

  it('upgrades a v2 database without losing the document row', async () => {
    const name = 't-v2-upgrade';
    const v2 = new Dexie(name);
    v2.version(1).stores({ documents: 'id', sources: 'id, order', chatHistory: 'id, order', suggestions: 'id', historyItems: 'id, timestamp', versionSnapshots: 'id, timestamp' });
    v2.version(2).stores({ grantTemplates: 'id, updatedAt' });
    await v2.open();
    await v2.table('documents').put({ id: 'current', title: 'Legacy', content: '<p>old</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
    v2.close();

    const db = new ManuscriptDb(name);
    const row = await db.documents.get('current');
    expect(row?.content).toBe('<p>old</p>');
    expect(row?.title).toBe('Legacy');
    db.close();
    await Dexie.delete(name);
  });

  it('autosaveBackups auto-increments seq', async () => {
    const db = new ManuscriptDb('t-backups');
    const a = await db.autosaveBackups.add({ documentId: 'current', savedAt: 1, row: { id: 'current', title: 'a', saveState: 'Draft', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 } });
    const b = await db.autosaveBackups.add({ documentId: 'current', savedAt: 2, row: { id: 'current', title: 'b', saveState: 'Draft', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 2 } });
    expect(Number(b)).toBeGreaterThan(Number(a));
    db.close();
    await Dexie.delete('t-backups');
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run src/db/manuscriptDb.test.ts`
Expected: FAIL (`ManuscriptDb` not exported / verno 2).

- [ ] **Step 5: Implement the v3 schema in `src/db/manuscriptDb.ts`**

Replace the file with:

```ts
import Dexie, { type Table } from 'dexie';
import type {
  DocumentRow,
  SourceRow,
  ChatHistoryRow,
  SuggestionRow,
  HistoryItemRow,
  VersionSnapshot,
  AssetRow,
  DocxPackageRow,
  BackupRow,
} from '../types';

export class ManuscriptDb extends Dexie {
  documents!: Table<DocumentRow>;
  sources!: Table<SourceRow>;
  chatHistory!: Table<ChatHistoryRow>;
  suggestions!: Table<SuggestionRow>;
  historyItems!: Table<HistoryItemRow>;
  versionSnapshots!: Table<VersionSnapshot>;
  grantTemplates!: Table<{ id: string; template: unknown; updatedAt: number }>;
  assets!: Table<AssetRow>;
  docxPackages!: Table<DocxPackageRow>;
  autosaveBackups!: Table<BackupRow>;

  constructor(name = 'ManuscriptAIEditor') {
    super(name);
    this.version(1).stores({
      documents: 'id',
      sources: 'id, order',
      chatHistory: 'id, order',
      suggestions: 'id',
      historyItems: 'id, timestamp',
      versionSnapshots: 'id, timestamp',
    });
    // v2: user-defined / AI-generated grant templates
    this.version(2).stores({
      grantTemplates: 'id, updatedAt',
    });
    // v3: canonical JSON documents, content-addressed assets, original DOCX packages, autosave backups.
    // Document HTML→JSON migration is lazy (DocumentRepository.load), not done in this upgrade:
    // it needs async hashing, which cannot run inside an IndexedDB upgrade transaction.
    this.version(3).stores({
      assets: 'id, sha256',
      docxPackages: 'documentId',
      autosaveBackups: '++seq, documentId, savedAt',
    });
  }
}

export const db = new ManuscriptDb();
```

- [ ] **Step 6: Run gates**

Run: `npx vitest run && npx tsc --noEmit` → all PASS, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/db/manuscriptDb.ts src/db/manuscriptDb.test.ts src/stores/useDocumentStore.ts
git commit -m "feat(a1): Dexie v3 schema (assets, docx packages, autosave backups)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Content-addressed asset store

**Files:**
- Create: `src/db/assetStore.ts`
- Modify: `src/extensions/ResizableImage.tsx:99-107` (add `assetId` attribute)
- Test: `src/db/assetStore.test.ts`

**Interfaces:**
- Consumes: `AssetRow` (Task 6). Image node name from `ResizableImage` (`name:` field; referred to below as `IMAGE_NODE`).
- Produces:
  - `IMAGE_NODE: string` (the image node's registered name, exported from `assetStore.ts`)
  - `sha256Hex(data: ArrayBuffer): Promise<string>`
  - `assetIdFor(sha: string): string` → `'a_' + sha.slice(0, 32)`
  - `dataUrlToBytes(url: string): { mime: string; data: ArrayBuffer }`
  - `prepareAssets(doc: JSONContent, opts?: { fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }> }): Promise<{ doc: JSONContent; assets: AssetRow[] }>`
  - `hydrateAssets(doc: JSONContent, getAsset: (id: string) => Promise<AssetRow | undefined>, resolver?: AssetUrlResolver): Promise<JSONContent>`
  - `collectAssetIds(doc: JSONContent | undefined): Set<string>`
  - `interface AssetUrlResolver { urlFor(row: AssetRow): string }`, `objectUrlResolver: AssetUrlResolver` (caches one object URL per asset id)

- [ ] **Step 1: Add the `assetId` attribute to `ResizableImage`**

In `src/extensions/ResizableImage.tsx`, inside `addAttributes()` add:

```ts
      assetId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-asset-id'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.assetId ? { 'data-asset-id': attrs.assetId } : {}),
      },
```

Also change `parseHTML()` from `[{ tag: 'img[src]' }]` to `[{ tag: 'img[src]' }, { tag: 'img[data-asset-id]' }]` so an image whose `src` was stripped still parses.

- [ ] **Step 2: Write the failing test**

Create `src/db/assetStore.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { prepareAssets, hydrateAssets, collectAssetIds, dataUrlToBytes, sha256Hex, assetIdFor, IMAGE_NODE } from './assetStore';
import type { AssetRow } from '../types';

// 1×1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const img = (src: string | null, assetId: string | null = null): JSONContent => ({ type: IMAGE_NODE, attrs: { src, assetId, alt: '', title: '', width: '100%', align: 'center' } });
const doc = (...nodes: JSONContent[]): JSONContent => ({ type: 'doc', content: nodes });

describe('asset store', () => {
  it('decodes data URLs', () => {
    const { mime, data } = dataUrlToBytes(PNG);
    expect(mime).toBe('image/png');
    expect(new Uint8Array(data).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47])); // "PNG"
  });

  it('moves data-URL images into assets and strips src', async () => {
    const { doc: out, assets } = await prepareAssets(doc(img(PNG)));
    expect(assets).toHaveLength(1);
    const a = assets[0];
    expect(a.id).toBe(assetIdFor(a.sha256));
    expect(a.mime).toBe('image/png');
    expect(out.content![0].attrs).toMatchObject({ src: null, assetId: a.id });
  });

  it('deduplicates identical images', async () => {
    const { doc: out, assets } = await prepareAssets(doc(img(PNG), img(PNG)));
    expect(assets).toHaveLength(1);
    expect(out.content![0].attrs!.assetId).toBe(out.content![1].attrs!.assetId);
  });

  it('leaves http(s) images untouched', async () => {
    const { doc: out, assets } = await prepareAssets(doc(img('https://example.org/x.png')));
    expect(assets).toHaveLength(0);
    expect(out.content![0].attrs!.src).toBe('https://example.org/x.png');
  });

  it('strips blob: src when the asset id is already known', async () => {
    const { doc: out } = await prepareAssets(doc(img('blob:abc', 'a_known')));
    expect(out.content![0].attrs).toMatchObject({ src: null, assetId: 'a_known' });
  });

  it('fetches blob: src without asset id', async () => {
    const bytes = dataUrlToBytes(PNG);
    const fetchBytes = vi.fn().mockResolvedValue(bytes);
    const { assets } = await prepareAssets(doc(img('blob:xyz')), { fetchBytes });
    expect(fetchBytes).toHaveBeenCalledWith('blob:xyz');
    expect(assets).toHaveLength(1);
  });

  it('hydrates asset ids back to URLs and marks missing ones', async () => {
    const { doc: stored, assets } = await prepareAssets(doc(img(PNG), img(null, 'a_missing')));
    const rows = new Map<string, AssetRow>(assets.map(a => [a.id, a]));
    const out = await hydrateAssets(stored, async id => rows.get(id), { urlFor: r => `url:${r.id}` });
    expect(out.content![0].attrs!.src).toBe(`url:${assets[0].id}`);
    expect(out.content![1].attrs).toMatchObject({ src: null, alt: '[missing image]' });
  });

  it('collects asset ids at any depth', async () => {
    const nested = doc({ type: 'blockquote', content: [img(null, 'a_1')] }, img(null, 'a_2'));
    expect([...collectAssetIds(nested)].sort()).toEqual(['a_1', 'a_2']);
    expect(collectAssetIds(undefined).size).toBe(0);
  });

  it('sha256Hex is the standard digest', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer);
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/db/assetStore.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `src/db/assetStore.ts`**

Set `IMAGE_NODE` to the exact `name:` value in `src/extensions/ResizableImage.tsx`.

```ts
import type { JSONContent } from '@tiptap/core';
import type { AssetRow } from '../types';

/** Registered name of the image node (must match ResizableImage's `name`). */
export const IMAGE_NODE = 'resizableImage';

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export const assetIdFor = (sha: string) => 'a_' + sha.slice(0, 32);

export function dataUrlToBytes(url: string): { mime: string; data: ArrayBuffer } {
  const comma = url.indexOf(',');
  const header = url.slice(5, comma); // after "data:"
  const mime = header.split(';')[0] || 'application/octet-stream';
  const payload = url.slice(comma + 1);
  if (header.includes(';base64')) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, data: bytes.buffer };
  }
  return { mime, data: new TextEncoder().encode(decodeURIComponent(payload)).buffer as ArrayBuffer };
}

async function defaultFetchBytes(url: string): Promise<{ mime: string; data: ArrayBuffer }> {
  const res = await fetch(url);
  return { mime: res.headers.get('content-type') ?? 'application/octet-stream', data: await res.arrayBuffer() };
}

function mapImages(doc: JSONContent, fn: (n: JSONContent) => JSONContent): JSONContent {
  const walk = (n: JSONContent): JSONContent => {
    const next = n.type === IMAGE_NODE ? fn(n) : n;
    return next.content ? { ...next, content: next.content.map(walk) } : next;
  };
  return walk(doc);
}

function forEachImage(doc: JSONContent | undefined, fn: (n: JSONContent) => void): void {
  if (!doc) return;
  if (doc.type === IMAGE_NODE) fn(doc);
  doc.content?.forEach(c => forEachImage(c, fn));
}

/**
 * Move embedded image bytes out of the document into asset rows (spec §2.3).
 * Pure apart from hashing/fetching: does not touch IndexedDB, so it can run before a Dexie transaction.
 */
export async function prepareAssets(
  doc: JSONContent,
  opts: { fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }> } = {},
): Promise<{ doc: JSONContent; assets: AssetRow[] }> {
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const assets = new Map<string, AssetRow>();
  const bySrc = new Map<string, string>(); // src → asset id
  const pending: string[] = [];
  forEachImage(doc, n => {
    const src = n.attrs?.src as string | null;
    if (!src) return;
    if (src.startsWith('data:') || (src.startsWith('blob:') && !n.attrs?.assetId)) pending.push(src);
  });
  for (const src of new Set(pending)) {
    const { mime, data } = src.startsWith('data:') ? dataUrlToBytes(src) : await fetchBytes(src);
    const sha = await sha256Hex(data);
    const id = assetIdFor(sha);
    bySrc.set(src, id);
    if (!assets.has(id)) assets.set(id, { id, sha256: sha, mime, size: data.byteLength, data, createdAt: Date.now() });
  }
  const out = mapImages(doc, n => {
    const src = n.attrs?.src as string | null;
    if (src && bySrc.has(src)) return { ...n, attrs: { ...n.attrs, src: null, assetId: bySrc.get(src) } };
    if (src?.startsWith('blob:') && n.attrs?.assetId) return { ...n, attrs: { ...n.attrs, src: null } };
    return n;
  });
  return { doc: out, assets: [...assets.values()] };
}

export interface AssetUrlResolver {
  urlFor(row: AssetRow): string;
}

const urlCache = new Map<string, string>();
export const objectUrlResolver: AssetUrlResolver = {
  urlFor(row) {
    let url = urlCache.get(row.id);
    if (!url) {
      url = URL.createObjectURL(new Blob([row.data], { type: row.mime }));
      urlCache.set(row.id, url);
    }
    return url;
  },
};

export async function hydrateAssets(
  doc: JSONContent,
  getAsset: (id: string) => Promise<AssetRow | undefined>,
  resolver: AssetUrlResolver = objectUrlResolver,
): Promise<JSONContent> {
  const ids = collectAssetIds(doc);
  const urls = new Map<string, string | null>();
  for (const id of ids) {
    const row = await getAsset(id);
    urls.set(id, row ? resolver.urlFor(row) : null);
  }
  return mapImages(doc, n => {
    const id = n.attrs?.assetId as string | null;
    if (!id) return n;
    const url = urls.get(id);
    return url ? { ...n, attrs: { ...n.attrs, src: url } } : { ...n, attrs: { ...n.attrs, src: null, alt: '[missing image]' } };
  });
}

export function collectAssetIds(doc: JSONContent | undefined): Set<string> {
  const ids = new Set<string>();
  forEachImage(doc, n => { if (typeof n.attrs?.assetId === 'string') ids.add(n.attrs.assetId); });
  return ids;
}
```

- [ ] **Step 5: Run gates**

Run: `npx vitest run && npx tsc --noEmit` → PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/db/assetStore.ts src/db/assetStore.test.ts src/extensions/ResizableImage.tsx
git commit -m "feat(a1): content-addressed image asset store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: DocumentRepository (atomic save, backups, lazy migration, recovery)

**Files:**
- Create: `src/db/documentRepository.ts`
- Test: `src/db/documentRepository.test.ts`

**Interfaces:**
- Consumes: `ManuscriptDb` (Task 6); `prepareAssets`, `hydrateAssets`, `collectAssetIds`, `AssetUrlResolver` (Task 7); `collectFragmentIds`, `pruneFragments` (Task 4); `createFormat` (Task 1).
- Produces:
  ```ts
  interface LoadedDocument {
    title: string; saveState: DocumentRow['saveState'];
    docJson: JSONContent; format: DocFormat; comments: CommentThread[];
    citationRegistry: Record<string, number>; citationCounter: number;
    figureRegistry: Record<string, number>; figureCounter: number;
    mode: DocumentMode; grantInstructions: string; grantTemplateId: string | null;
  }
  interface LoadResult { doc: LoadedDocument | null; migrated: boolean; recoveredFromBackup: boolean }
  interface DocumentRepository {
    load(): Promise<LoadResult>;
    save(doc: LoadedDocument): Promise<void>;
    getPackage(): Promise<DocxPackageRow | undefined>;
    savePackage(pkg: DocxPackageRow): Promise<void>;
    listBackups(): Promise<BackupRow[]>;          // newest first
    restoreBackup(seq: number): Promise<LoadedDocument>;
  }
  interface RepositoryDeps {
    htmlToDoc(html: string): JSONContent;
    isValidDoc(doc: unknown): boolean;
    resolver?: AssetUrlResolver;
    fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }>;
    maxBackups?: number; // default 10
  }
  function createDexieRepository(db: ManuscriptDb, deps: RepositoryDeps): DocumentRepository
  ```

Behavior:
- `load`: no row → `{doc:null}`. Row with valid `docJson` → hydrated doc. Row with invalid `docJson` → newest backup whose row converts to a valid doc → `recoveredFromBackup: true`; if none, `doc: null` + `recoveredFromBackup: false` (caller shows defaults). Row with only `content` → `htmlToDoc(content)`, then **immediately `save`** (the pre-migration row becomes the first backup) → `migrated: true`.
- `save`: serialized through a promise queue (overlapping calls run in call order; each caller's promise settles with its own result). Hashing/fetching happens **before** the transaction. One `rw` transaction over `documents`, `assets`, `autosaveBackups`, `docxPackages`: back up the previous row (if any), trim backups to `maxBackups`, `bulkPut` new assets, `put` the row (no `content`), delete assets referenced by neither the new row nor any remaining backup, prune package fragments the same way.

- [ ] **Step 1: Write the failing test**

Create `src/db/documentRepository.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Dexie from 'dexie';
import { ManuscriptDb } from './manuscriptDb';
import { createDexieRepository, type LoadedDocument, type DocumentRepository } from './documentRepository';
import { htmlToDoc, isValidDoc } from '../extensions/schema';
import { createFormat } from '../services/formatPresets';
import { IMAGE_NODE } from './assetStore';
import { emptyPreservationStore } from '../docx/preserve/types';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
let db: ManuscriptDb;
let repo: DocumentRepository;
let name: string;
const resolver = { urlFor: (r: { id: string }) => `url:${r.id}` };

const baseDoc = (text: string): LoadedDocument => ({
  title: 'T', saveState: 'Draft',
  docJson: htmlToDoc(`<p>${text}</p>`), format: createFormat('nih'), comments: [],
  citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0,
  mode: 'grant', grantInstructions: '', grantTemplateId: null,
});

beforeEach(async () => {
  name = 't-repo-' + Math.random().toString(36).slice(2);
  db = new ManuscriptDb(name);
  repo = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver });
});
afterEach(async () => { db.close(); await Dexie.delete(name); });

describe('DocumentRepository', () => {
  it('fresh install: no document', async () => {
    expect(await repo.load()).toEqual({ doc: null, migrated: false, recoveredFromBackup: false });
  });

  it('save then load round-trips and never persists HTML', async () => {
    await repo.save(baseDoc('hello'));
    const row = await db.documents.get('current');
    expect(row?.content).toBeUndefined();
    expect(row?.schemaVersion).toBe(3);
    const { doc } = await repo.load();
    expect(JSON.stringify(doc?.docJson)).toContain('hello');
    expect(doc?.format.preset).toBe('nih');
    expect(doc?.mode).toBe('grant');
  });

  it('migrates a legacy HTML row once and backs up the original', async () => {
    await db.documents.put({ id: 'current', title: 'Legacy', content: `<p>old <strong>text</strong></p><img src="${PNG}">`, saveState: 'Saved', citationRegistry: { s1: 1 }, citationCounter: 1, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
    const r = await repo.load();
    expect(r.migrated).toBe(true);
    expect(JSON.stringify(r.doc?.docJson)).toContain('old');
    expect(r.doc?.format.preset).toBe('nih');
    expect(r.doc?.citationRegistry).toEqual({ s1: 1 });
    const row = await db.documents.get('current');
    expect(row?.content).toBeUndefined();
    expect(await db.assets.count()).toBe(1);
    const backups = await repo.listBackups();
    expect(backups[0].row.content).toContain('old');
    // image hydrated to a resolver URL
    const imgNode = r.doc!.docJson.content!.flatMap(n => [n, ...(n.content ?? [])]).find(n => n.type === IMAGE_NODE);
    expect(imgNode?.attrs?.src).toMatch(/^url:a_/);
    expect((await repo.load()).migrated).toBe(false);
  });

  it('keeps at most maxBackups backups', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxBackups: 3 });
    for (let i = 0; i < 6; i++) await small.save(baseDoc('v' + i));
    const b = await small.listBackups();
    expect(b).toHaveLength(3);
    expect(JSON.stringify(b[0].row.docJson)).toContain('v4');
  });

  it('overlapping saves complete in call order (last write wins)', async () => {
    const p1 = repo.save(baseDoc('first'));
    const p2 = repo.save(baseDoc('second'));
    await Promise.all([p1, p2]);
    const { doc } = await repo.load();
    expect(JSON.stringify(doc?.docJson)).toContain('second');
  });

  it('a failing transaction leaves the previous document intact', async () => {
    await repo.save(baseDoc('good'));
    const unhook = db.assets.hook('creating', () => { throw new Error('disk full'); });
    const withImage = baseDoc('bad');
    withImage.docJson = htmlToDoc(`<p>bad</p><img src="${PNG}">`);
    await expect(repo.save(withImage)).rejects.toThrow();
    db.assets.hook('creating').unsubscribe(unhook as any);
    const { doc } = await repo.load();
    expect(JSON.stringify(doc?.docJson)).toContain('good');
    // queue still usable after a failure
    await repo.save(baseDoc('after'));
    expect(JSON.stringify((await repo.load()).doc?.docJson)).toContain('after');
  });

  it('recovers from a corrupt docJson using the newest valid backup', async () => {
    await repo.save(baseDoc('v1'));
    await repo.save(baseDoc('v2'));
    const row = await db.documents.get('current');
    await db.documents.put({ ...row!, docJson: { type: 'doc', content: [{ type: 'hologram' }] } as any });
    const r = await repo.load();
    expect(r.recoveredFromBackup).toBe(true);
    expect(JSON.stringify(r.doc?.docJson)).toContain('v1');
  });

  it('garbage-collects assets no longer referenced by the doc or any backup', async () => {
    const small = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver, maxBackups: 1 });
    const withImage = baseDoc('img');
    withImage.docJson = htmlToDoc(`<p>img</p><img src="${PNG}">`);
    await small.save(withImage);
    expect(await db.assets.count()).toBe(1);
    await small.save(baseDoc('no image 1')); // backup still references the image
    expect(await db.assets.count()).toBe(1);
    await small.save(baseDoc('no image 2')); // image-bearing row fell out of the ring
    expect(await db.assets.count()).toBe(0);
  });

  it('prunes unreferenced preservation fragments on save', async () => {
    const store = emptyPreservationStore();
    store.fragments = { f1: { xml: '<a/>', relIds: [], nsDecls: {} }, f2: { xml: '<b/>', relIds: [], nsDecls: {} } };
    await repo.savePackage({ documentId: 'current', original: new ArrayBuffer(4), fileName: 'x.docx', preservation: store, importedAt: 1 });
    const d = baseDoc('chip');
    d.docJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } }] }] };
    await repo.save(d);
    const pkg = await repo.getPackage();
    expect(Object.keys(pkg!.preservation.fragments)).toEqual(['f1']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/db/documentRepository.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/db/documentRepository.ts`**

```ts
import type { JSONContent } from '@tiptap/core';
import type { ManuscriptDb } from './manuscriptDb';
import type { BackupRow, CommentThread, DocFormat, DocumentMode, DocumentRow, DocxPackageRow } from '../types';
import { prepareAssets, hydrateAssets, collectAssetIds, type AssetUrlResolver } from './assetStore';
import { collectFragmentIds, pruneFragments } from '../docx/preserve/xml';
import { createFormat } from '../services/formatPresets';

export interface LoadedDocument {
  title: string;
  saveState: DocumentRow['saveState'];
  docJson: JSONContent;
  format: DocFormat;
  comments: CommentThread[];
  citationRegistry: Record<string, number>;
  citationCounter: number;
  figureRegistry: Record<string, number>;
  figureCounter: number;
  mode: DocumentMode;
  grantInstructions: string;
  grantTemplateId: string | null;
}

export interface LoadResult {
  doc: LoadedDocument | null;
  migrated: boolean;
  recoveredFromBackup: boolean;
}

export interface DocumentRepository {
  load(): Promise<LoadResult>;
  save(doc: LoadedDocument): Promise<void>;
  getPackage(): Promise<DocxPackageRow | undefined>;
  savePackage(pkg: DocxPackageRow): Promise<void>;
  listBackups(): Promise<BackupRow[]>;
  restoreBackup(seq: number): Promise<LoadedDocument>;
}

export interface RepositoryDeps {
  htmlToDoc(html: string): JSONContent;
  isValidDoc(doc: unknown): boolean;
  resolver?: AssetUrlResolver;
  fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }>;
  maxBackups?: number;
}

export function createDexieRepository(db: ManuscriptDb, deps: RepositoryDeps): DocumentRepository {
  const maxBackups = deps.maxBackups ?? 10;
  let queue: Promise<unknown> = Promise.resolve();

  /** Convert a stored row to a LoadedDocument (no hydration). Returns null if the body is unusable. */
  function rowToDoc(row: DocumentRow): { doc: LoadedDocument; fromHtml: boolean } | null {
    let docJson: JSONContent | null = null;
    let fromHtml = false;
    if (row.docJson !== undefined) {
      docJson = deps.isValidDoc(row.docJson) ? row.docJson : null;
    } else if (typeof row.content === 'string') {
      docJson = deps.htmlToDoc(row.content);
      fromHtml = true;
    }
    if (!docJson) return null;
    return {
      fromHtml,
      doc: {
        title: row.title,
        saveState: row.saveState,
        docJson,
        format: row.format ?? createFormat('nih'),
        comments: row.comments ?? [],
        citationRegistry: row.citationRegistry ?? {},
        citationCounter: row.citationCounter ?? 0,
        figureRegistry: row.figureRegistry ?? {},
        figureCounter: row.figureCounter ?? 0,
        mode: row.mode ?? 'manuscript',
        grantInstructions: row.grantInstructions ?? '',
        grantTemplateId: row.grantTemplateId ?? null,
      },
    };
  }

  async function hydrate(doc: LoadedDocument): Promise<LoadedDocument> {
    const docJson = await hydrateAssets(doc.docJson, id => db.assets.get(id), deps.resolver);
    return { ...doc, docJson };
  }

  async function doSave(doc: LoadedDocument): Promise<void> {
    // Async work that is not IndexedDB (hashing, fetching) must happen before the transaction.
    const { doc: storedJson, assets } = await prepareAssets(doc.docJson, { fetchBytes: deps.fetchBytes });
    const row: DocumentRow = {
      id: 'current',
      title: doc.title,
      docJson: storedJson,
      format: doc.format,
      comments: doc.comments,
      schemaVersion: 3,
      saveState: doc.saveState,
      citationRegistry: doc.citationRegistry,
      citationCounter: doc.citationCounter,
      figureRegistry: doc.figureRegistry,
      figureCounter: doc.figureCounter,
      updatedAt: Date.now(),
      mode: doc.mode,
      grantInstructions: doc.grantInstructions,
      grantTemplateId: doc.grantTemplateId ?? undefined,
    };
    await db.transaction('rw', [db.documents, db.assets, db.autosaveBackups, db.docxPackages], async () => {
      const prev = await db.documents.get('current');
      if (prev) await db.autosaveBackups.add({ documentId: 'current', savedAt: Date.now(), row: prev });
      const all = await db.autosaveBackups.orderBy('seq').primaryKeys();
      const excess = all.length - maxBackups;
      if (excess > 0) await db.autosaveBackups.bulkDelete(all.slice(0, excess));
      if (assets.length) await db.assets.bulkPut(assets);
      await db.documents.put(row);

      const backups = await db.autosaveBackups.toArray();
      const keepAssets = collectAssetIds(row.docJson);
      const keepFragments = collectFragmentIds(row.docJson!);
      for (const b of backups) {
        collectAssetIds(b.row.docJson).forEach(id => keepAssets.add(id));
        if (b.row.docJson) collectFragmentIds(b.row.docJson).forEach(id => keepFragments.add(id));
      }
      const allAssetIds = (await db.assets.toCollection().primaryKeys()) as string[];
      const dead = allAssetIds.filter(id => !keepAssets.has(id));
      if (dead.length) await db.assets.bulkDelete(dead);

      const pkg = await db.docxPackages.get('current');
      if (pkg) await db.docxPackages.put({ ...pkg, preservation: pruneFragments(pkg.preservation, keepFragments) });
    });
  }

  const repo: DocumentRepository = {
    save(doc) {
      const run = queue.then(() => doSave(doc));
      queue = run.catch(() => undefined); // keep the queue alive after a failure
      return run;
    },

    async load() {
      const row = await db.documents.get('current');
      if (!row) return { doc: null, migrated: false, recoveredFromBackup: false };
      const converted = rowToDoc(row);
      if (converted) {
        if (converted.fromHtml) {
          await repo.save(converted.doc); // pre-migration row becomes the newest backup
          const fresh = rowToDoc((await db.documents.get('current'))!)!;
          return { doc: await hydrate(fresh.doc), migrated: true, recoveredFromBackup: false };
        }
        return { doc: await hydrate(converted.doc), migrated: false, recoveredFromBackup: false };
      }
      for (const b of await repo.listBackups()) {
        const c = rowToDoc(b.row);
        if (c) return { doc: await hydrate(c.doc), migrated: false, recoveredFromBackup: true };
      }
      return { doc: null, migrated: false, recoveredFromBackup: false };
    },

    getPackage: () => db.docxPackages.get('current'),
    async savePackage(pkg) { await db.docxPackages.put(pkg); },

    async listBackups() {
      return (await db.autosaveBackups.orderBy('seq').toArray()).reverse();
    },

    async restoreBackup(seq) {
      const b = await db.autosaveBackups.get(seq);
      const c = b && rowToDoc(b.row);
      if (!c) throw new Error(`Backup ${seq} is missing or unreadable`);
      return hydrate(c.doc);
    },
  };
  return repo;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/db/documentRepository.test.ts`
Expected: PASS (9 tests). If the "failing transaction" test leaves a hook installed, change it to keep the function reference: `const failer = () => { throw new Error('disk full'); }; db.assets.hook('creating', failer); … db.assets.hook('creating').unsubscribe(failer);`.

- [ ] **Step 5: Run gates**

Run: `npx vitest run && npx tsc --noEmit` → PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/db/documentRepository.ts src/db/documentRepository.test.ts
git commit -m "feat(a1): atomic DocumentRepository with backups, lazy migration, recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Store, Editor and App wiring

**Files:**
- Modify: `src/stores/useDocumentStore.ts`
- Modify: `src/components/Editor.tsx` (props, `onUpdate`, external sync effect at `:470-479`, ref `setContent` at `:768-774`, add `onCreate`; add `OpaqueFragmentGuard`)
- Modify: `src/App.tsx` (init effect `:244-263`, `<Editor … onChange>` at `:1333`)
- Test: `src/stores/useDocumentStore.test.ts`

**Interfaces:**
- Consumes: `createDexieRepository`, `LoadedDocument` (Task 8); `db` (Task 6); `htmlToDoc`, `docToHtml`, `isValidDoc` (Task 2); `createFormat` (Task 1); `OpaqueFragmentGuard` (Task 4).
- Produces (store additions):
  - state: `docJson: JSONContent | null`, `format: DocFormat`, `comments: CommentThread[]`, `lastLoad: { migrated: boolean; recoveredFromBackup: boolean }`
  - actions: `setDocJson(doc: JSONContent): void`, `setFormat(f: DocFormat): void`, `setComments(c: CommentThread[]): void`
  - `documentRepository` (module export) — the app's singleton repository
- Produces (Editor): optional prop `onDocChange?: (doc: JSONContent) => void`, invoked after every editor content change, including external `setContent` and initial creation.

- [ ] **Step 1: Write the failing store test**

Create `src/stores/useDocumentStore.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/manuscriptDb';
import { useDocumentStore } from './useDocumentStore';
import { htmlToDoc } from '../extensions/schema';

beforeEach(async () => {
  await db.delete();
  await db.open();
  useDocumentStore.getState().resetDocument();
});

describe('useDocumentStore (v3)', () => {
  it('fresh install loads NIH defaults without a recovery flag', async () => {
    await useDocumentStore.getState().initialize();
    const s = useDocumentStore.getState();
    expect(s.format.preset).toBe('nih');
    expect(s.lastLoad).toEqual({ migrated: false, recoveredFromBackup: false });
  });

  it('migrates a legacy row: content is derived HTML, docJson is canonical', async () => {
    await db.documents.put({ id: 'current', title: 'Legacy', content: '<h2>Aims</h2><p>old text</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
    await useDocumentStore.getState().initialize();
    const s = useDocumentStore.getState();
    expect(s.lastLoad.migrated).toBe(true);
    expect(s.title).toBe('Legacy');
    expect(s.content).toContain('old text');
    expect(JSON.stringify(s.docJson)).toContain('old text');
  });

  it('persist writes docJson from the editor, not HTML', async () => {
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>from editor</p>'));
    await useDocumentStore.getState().persist();
    const row = await db.documents.get('current');
    expect(row?.content).toBeUndefined();
    expect(JSON.stringify(row?.docJson)).toContain('from editor');
  });

  it('persist falls back to converting content when the editor has not reported yet', async () => {
    useDocumentStore.setState({ docJson: null, content: '<p>only html</p>' });
    await useDocumentStore.getState().persist();
    expect(JSON.stringify((await db.documents.get('current'))?.docJson)).toContain('only html');
  });

  it('format changes persist', async () => {
    const { setFormat } = useDocumentStore.getState();
    const f = structuredClone(useDocumentStore.getState().format);
    f.page.marginsIn.left = 1;
    setFormat(f);
    useDocumentStore.getState().setDocJson(htmlToDoc('<p>x</p>'));
    await useDocumentStore.getState().persist();
    expect((await db.documents.get('current'))?.format?.page.marginsIn.left).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/stores/useDocumentStore.test.ts` → FAIL (`format`/`setDocJson` missing).

- [ ] **Step 3: Update `src/stores/useDocumentStore.ts`**

Changes (keep every existing action and its behavior):

1. Imports:
```ts
import type { JSONContent } from '@tiptap/core';
import { db } from '../db/manuscriptDb';
import { createDexieRepository, type LoadedDocument } from '../db/documentRepository';
import { htmlToDoc, docToHtml, isValidDoc } from '../extensions/schema';
import { createFormat } from '../services/formatPresets';
import type { CommentThread, DocFormat, DocumentMode } from '../types';

export const documentRepository = createDexieRepository(db, { htmlToDoc, isValidDoc });
```

2. Add to `DocumentState`:
```ts
  /** Canonical document, always produced by the editor (onDocChange) or the repository. */
  docJson: JSONContent | null;
  format: DocFormat;
  comments: CommentThread[];
  lastLoad: { migrated: boolean; recoveredFromBackup: boolean };
  setDocJson: (doc: JSONContent) => void;
  setFormat: (format: DocFormat) => void;
  setComments: (comments: CommentThread[]) => void;
```
and change the doc comment on `content` to: `/** Derived HTML (never persisted). Writing it commands the editor; the editor then reports docJson. */`.

3. Initial state additions: `docJson: null, format: createFormat('nih'), comments: [], lastLoad: { migrated: false, recoveredFromBackup: false },`
   Actions: `setDocJson: (docJson) => set({ docJson }), setFormat: (format) => set({ format, saveState: 'Draft' }), setComments: (comments) => set({ comments, saveState: 'Draft' }),`

4. `resetDocument`: also reset `docJson: null, format: createFormat('nih'), comments: []`.

5. Replace `initialize`:
```ts
  initialize: async () => {
    try {
      const result = await documentRepository.load();
      if (result.doc) {
        const d = result.doc;
        set({
          title: d.title,
          content: docToHtml(d.docJson),
          docJson: d.docJson,
          format: d.format,
          comments: d.comments,
          saveState: d.saveState,
          citationRegistry: d.citationRegistry,
          citationCounter: d.citationCounter,
          figureRegistry: d.figureRegistry,
          figureCounter: d.figureCounter,
          mode: d.mode,
          grantInstructions: d.grantInstructions,
          grantTemplateId: d.grantTemplateId,
          lastLoad: { migrated: result.migrated, recoveredFromBackup: result.recoveredFromBackup },
        });
        return;
      }
      set({ lastLoad: { migrated: false, recoveredFromBackup: result.recoveredFromBackup } });

      // Fall back to legacy localforage (pre-Dexie installs)
      const localforage = await import('localforage');
      const data: any = await localforage.default.getItem('manuscript-ai-editor-autosave');
      if (data?.content) {
        const registry: Record<string, number> = data.citationRegistry || {};
        set({
          title: data.title || 'Untitled Manuscript',
          content: data.content,
          docJson: htmlToDoc(data.content),
          saveState: 'Auto-saved',
          citationRegistry: registry,
          citationCounter: Object.keys(registry).length,
        });
        await get().persist();
        await localforage.default.removeItem('manuscript-ai-editor-autosave');
      }
    } catch (err) {
      console.error('DocumentStore.initialize failed:', err);
    }
  },
```

6. Replace `persist`:
```ts
  persist: async () => {
    const s = get();
    const doc: LoadedDocument = {
      title: s.title,
      saveState: s.saveState,
      docJson: s.docJson ?? htmlToDoc(s.content),
      format: s.format,
      comments: s.comments,
      citationRegistry: s.citationRegistry,
      citationCounter: s.citationCounter,
      figureRegistry: s.figureRegistry,
      figureCounter: s.figureCounter,
      mode: s.mode,
      grantInstructions: s.grantInstructions,
      grantTemplateId: s.grantTemplateId,
    };
    await documentRepository.save(doc);
  },
```

Remove the now-unused `DocumentRow` import if tsc flags it.

- [ ] **Step 4: Run the store test**

Run: `npx vitest run src/stores/useDocumentStore.test.ts` → PASS (5 tests).

- [ ] **Step 5: Editor — report JSON on every content change**

In `src/components/Editor.tsx`:

a) Add to `EditorProps`:
```ts
  /** Called with the canonical document after every content change (including external setContent). */
  onDocChange?: (doc: JSONContent) => void;
```
Import `type JSONContent` from `@tiptap/core`, and `OpaqueFragmentGuard` from `'../extensions/preserve/OpaqueNodes'`.

b) Destructure `onDocChange` from props and keep it in a ref so editor callbacks always see the latest:
```ts
  const onDocChangeRef = useRef(onDocChange);
  useEffect(() => { onDocChangeRef.current = onDocChange; }, [onDocChange]);
```

c) In `useEditor({...})`:
- add `OpaqueFragmentGuard,` to the extensions array after `...getSchemaExtensions()` (A2 passes `onDuplicateFragment` through when DOCX packages exist; the default no-op is correct for A1).
- add `onCreate: ({ editor }) => { onDocChangeRef.current?.(editor.getJSON()); },`
- in `onUpdate`, report JSON **before** the `isExternalUpdate` early return so programmatic changes are reported too:
```ts
    onUpdate: ({ editor }) => {
      onDocChangeRef.current?.(editor.getJSON());
      if (isExternalUpdate.current) return;
      const html = editor.getHTML();
      lastExternalContent.current = html;
      onChange(html);
    },
```

d) In the "Sync content from parent" effect and in the ref's `setContent`, add `onDocChangeRef.current?.(editor.getJSON());` immediately after `editor.commands.setContent(...)` (TipTap's `setContent` does not emit `update` by default, so this call is required).

- [ ] **Step 6: App — wire `onDocChange` and the recovery toast**

In `src/App.tsx`:
- Pull `setDocJson` from `useDocumentStore` alongside `setContent`.
- On the `<Editor` element (near `onChange={(html) => setContent(html)}`) add `onDocChange={setDocJson}`.
- In the init effect's `.then(() => { … })`, first add:
```ts
      const { lastLoad } = useDocumentStore.getState();
      if (lastLoad.recoveredFromBackup) {
        showToast('Your last save could not be read. Restored the most recent backup.', 'error');
      }
```

- [ ] **Step 7: Run gates**

Run: `npx tsc --noEmit && npx vitest run` → exit 0; all tests PASS.

- [ ] **Step 8: Manual check in the dev server**

Run: `npm run dev` (background), open http://localhost:3000, type a sentence, wait 31 s for autosave, reload the page.
Expected: the sentence is still there; DevTools → Application → IndexedDB → `ManuscriptAIEditor` → `documents` → `current` has `docJson` and no `content`.

- [ ] **Step 9: Commit**

```bash
git add src/stores/useDocumentStore.ts src/stores/useDocumentStore.test.ts src/components/Editor.tsx src/App.tsx
git commit -m "feat(a1): repository-backed document store; editor reports canonical JSON

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: A1 gate — migration fidelity, smoke test, CI

**Files:**
- Create: `src/test/fixtures/legacyV2.ts`
- Create: `src/db/migration.gate.test.ts`
- Create: `scripts/smoke/a1-persistence.mjs`
- Modify: `.github/workflows/webpack.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: the A1 gate evidence (spec phase table: "Migration of existing docs lossless; repository atomicity tests").

- [ ] **Step 1: Create the realistic legacy fixture**

Create `src/test/fixtures/legacyV2.ts` (exercise every node/mark the v2 editor could produce):

```ts
export const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const LEGACY_V2_HTML = [
  '<h1>Title of the Application</h1>',
  '<h2>Specific Aims</h2>',
  '<p style="text-align: justify">HERV-K envelope <strong>bold</strong> <em>italic</em> <u>under</u> ',
  '<s>strike</s> <code>code</code> <mark data-color="#fef08a" style="background-color: #fef08a">highlighted</mark> ',
  '<a href="https://example.org" target="_blank" rel="noopener noreferrer nofollow">link</a> ',
  'cited <span data-citation-node="" data-source-ids="src-a,src-b" data-nums="1,2">[1,2]</span> and ',
  '<span data-figure-label="" data-figure-id="fig-1" data-figure-num="1">Figure 1</span>.</p>',
  '<h3>Aim 1</h3>',
  '<ul><li><p>bullet</p><ul><li><p>nested bullet</p></li></ul></li></ul>',
  '<ol><li><p>first</p></li><li><p>second</p></li></ol>',
  '<blockquote><p>quoted</p></blockquote>',
  '<pre><code>code block</code></pre>',
  '<hr>',
  '<table><tbody><tr><th colspan="2"><p>Header</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>',
  `<img src="${PNG_1PX}" alt="fig" width="50%" data-align="left">`,
  `<img src="${PNG_1PX}" alt="same fig again">`,
  '<p>Last paragraph.</p>',
].join('');

export const LEGACY_V2_ROW = {
  id: 'current' as const,
  title: 'R01 HERV-K (legacy)',
  content: LEGACY_V2_HTML,
  saveState: 'Saved' as const,
  citationRegistry: { 'src-a': 1, 'src-b': 2 },
  citationCounter: 2,
  figureRegistry: { 'fig-1': 1 },
  figureCounter: 1,
  updatedAt: 1_700_000_000_000,
  mode: 'grant' as const,
  grantInstructions: 'PAR-25-123 notes',
  grantTemplateId: 'nih-r01',
};
```

If the figure label's `parseHTML` needs a different attribute set than shown (check `src/extensions/FigureLabel.tsx` `parseHTML`/`addAttributes`), adjust the `<span data-figure-label …>` attributes to match what `renderHTML` produces.

- [ ] **Step 2: Write the gate test**

Create `src/db/migration.gate.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import type { JSONContent } from '@tiptap/core';
import { ManuscriptDb } from './manuscriptDb';
import { createDexieRepository } from './documentRepository';
import { htmlToDoc, docToHtml, isValidDoc } from '../extensions/schema';
import { IMAGE_NODE, dataUrlToBytes } from './assetStore';
import { LEGACY_V2_ROW, LEGACY_V2_HTML, PNG_1PX } from '../test/fixtures/legacyV2';

/** Replace hydrated image URLs with a placeholder so trees can be compared. */
function withoutImageSrc(doc: JSONContent): JSONContent {
  const walk = (n: JSONContent): JSONContent => {
    const m = n.type === IMAGE_NODE ? { ...n, attrs: { ...n.attrs, src: '<img>', assetId: null } } : n;
    return m.content ? { ...m, content: m.content.map(walk) } : m;
  };
  return walk(doc);
}

describe('A1 gate: legacy v2 document migrates losslessly', () => {
  it('migrated document equals a direct parse of the legacy HTML, and image bytes survive', async () => {
    const name = 'gate-' + Math.random().toString(36).slice(2);
    const db = new ManuscriptDb(name);
    await db.documents.put(LEGACY_V2_ROW);
    const repo = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver: { urlFor: r => `url:${r.id}` } });

    const first = await repo.load();
    expect(first.migrated).toBe(true);
    const expected = withoutImageSrc(htmlToDoc(LEGACY_V2_HTML));
    expect(withoutImageSrc(first.doc!.docJson)).toEqual(expected);

    // metadata carried over
    expect(first.doc).toMatchObject({
      title: LEGACY_V2_ROW.title,
      citationRegistry: LEGACY_V2_ROW.citationRegistry,
      figureRegistry: LEGACY_V2_ROW.figureRegistry,
      mode: 'grant',
      grantInstructions: 'PAR-25-123 notes',
      grantTemplateId: 'nih-r01',
    });

    // both images share one asset with the original bytes
    const assets = await db.assets.toArray();
    expect(assets).toHaveLength(1);
    expect(new Uint8Array(assets[0].data)).toEqual(new Uint8Array(dataUrlToBytes(PNG_1PX).data));

    // second load (no migration) is identical; a save/load cycle is a fixed point
    const second = await repo.load();
    expect(second.migrated).toBe(false);
    expect(second.doc!.docJson).toEqual(first.doc!.docJson);
    await repo.save(second.doc!);
    expect((await repo.load()).doc!.docJson).toEqual(first.doc!.docJson);

    // original HTML retained in the backup ring for recovery
    const backups = await repo.listBackups();
    expect(backups.some(b => b.row.content === LEGACY_V2_HTML)).toBe(true);

    // rendered HTML still carries citations and figure labels for existing App code
    const html = docToHtml(first.doc!.docJson);
    expect(html).toContain('data-citation-node');
    expect(html).toContain('data-source-ids="src-a,src-b"');

    db.close();
    await Dexie.delete(name);
  });

  it('ten save/load cycles cause no drift', async () => {
    const name = 'gate-drift-' + Math.random().toString(36).slice(2);
    const db = new ManuscriptDb(name);
    await db.documents.put(LEGACY_V2_ROW);
    const repo = createDexieRepository(db, { htmlToDoc, isValidDoc, resolver: { urlFor: r => `url:${r.id}` } });
    const base = (await repo.load()).doc!;
    let cur = base;
    for (let i = 0; i < 10; i++) {
      await repo.save(cur);
      cur = (await repo.load()).doc!;
    }
    expect(cur.docJson).toEqual(base.docJson);
    db.close();
    await Dexie.delete(name);
  });
});
```

- [ ] **Step 3: Run the gate test**

Run: `npx vitest run src/db/migration.gate.test.ts`
Expected: PASS. If the tree comparison fails, the diff shows which node/attribute is lost; fix the extension's `parseHTML`/`renderHTML` (do **not** weaken the assertion).

- [ ] **Step 4: Add the Playwright smoke script**

Create `scripts/smoke/a1-persistence.mjs`:

```js
// A1 smoke: legacy document migrates, edits persist across reload, row stores JSON not HTML.
// Usage: npm run dev (port 3000) in another terminal, then:
//   npm i --no-save playwright && npx playwright install chromium && node scripts/smoke/a1-persistence.mjs
import { chromium } from 'playwright';

const URL = process.env.APP_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();
const page = await browser.newPage();
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

await page.goto(URL);
// Seed a legacy v2 row directly, then reload so the app migrates it.
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('ManuscriptAIEditor');
    req.onsuccess = () => {
      const tx = req.result.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({ id: 'current', title: 'Smoke', content: '<h2>Aims</h2><p>legacy smoke text</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
});
await page.reload();
await page.waitForSelector('.ProseMirror');
if (!(await page.textContent('.ProseMirror')).includes('legacy smoke text')) fail('legacy text not shown after migration');

await page.click('.ProseMirror p:last-of-type');
await page.keyboard.press('End');
await page.keyboard.type(' plus an edit');
await page.waitForTimeout(31_000); // autosave interval

const row = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ManuscriptAIEditor');
  req.onsuccess = () => {
    const get = req.result.transaction('documents').objectStore('documents').get('current');
    get.onsuccess = () => { resolve(get.result); req.result.close(); };
  };
}));
if (row.content !== undefined) fail('row still stores HTML content');
if (!JSON.stringify(row.docJson).includes('plus an edit')) fail('edit not persisted in docJson');

await page.reload();
await page.waitForSelector('.ProseMirror');
if (!(await page.textContent('.ProseMirror')).includes('plus an edit')) fail('edit lost after reload');

await browser.close();
if (!process.exitCode) console.log('A1 smoke: PASS');
```

- [ ] **Step 5: Run the smoke test**

Run (dev server in background first):
```bash
npm run dev > /tmp/claude-dev.log 2>&1 &
npm i --no-save playwright && npx playwright install chromium
node scripts/smoke/a1-persistence.mjs
```
Expected: `A1 smoke: PASS`. Stop the dev server afterwards. If Chromium cannot launch in this WSL environment, record the error in the task report and run Step 8 of Task 9 manually instead — do not skip silently.

- [ ] **Step 6: Add type-check and tests to CI**

In `.github/workflows/webpack.yml`, replace the `Build` step's `run` block with:

```yaml
      run: |
        npm install
        npx tsc --noEmit
        npx vitest run
        npm run build
```

- [ ] **Step 7: Run all gates**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc exit 0; all tests PASS; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/test/fixtures/legacyV2.ts src/db/migration.gate.test.ts scripts/smoke/a1-persistence.mjs .github/workflows/webpack.yml
git commit -m "test(a1): migration fidelity gate, persistence smoke test, CI type-check + tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage (A1)

| Spec item | Task |
|---|---|
| §1 Fidelity contract (categories, report) | 5 |
| §2.1 JSON canonical, HTML derived, legacy content removed from row | 2, 8, 9, 10 |
| §2.2 Format model, presets, styles incl. character styles + preserved props | 1 |
| §2.3 Asset store, dedupe, GC | 7, 8 |
| §2.4 Block provenance + verbatim-reuse hash | 3 |
| §2.4 Opaque atoms, namespace capture, rel remap, copy/delete behaviors | 4 |
| §2.4 Package parts preserved (storage of original + preservation store) | 6, 8 |
| §2.5 Repository, atomic save, comments in row, backups, migration, recovery | 6, 8, 9 |
| §2.6 Import transaction boundary | Interface ready (`savePackage`); importer itself is A2 |
| §2.7 Import security | A2 (consumes the raw bytes; not part of the model) |
| §8.1 CI runs tsc + tests | 10 |

Deferred deliberately: paired-marker (bookmark) linking and paragraph-level `sectPr` attributes need the A2 reader to produce them; their storage (`opaqueInline` + `PreservationStore`) exists after Task 4.
