import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Every place the app replaces the open document with something that is NOT the imported .docx must end the document's tie to the
 * import (the store's `resetDocument` / `allowOverwrite` clear `importId`; the next save then detaches the package). The handlers
 * live in the 1,700-line App component, which is not mounted in a test, so this reads its source: if a new replace-document flow is
 * added without one of the two calls, or one of these loses it, this fails. The store half of the guarantee is tested for real in
 * useDocumentStore.test.ts.
 */
const src = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

/** The text of `const NAME = ... => {` up to the next top-level `  const ` declaration. */
function handler(name: string): string {
  const start = src.indexOf(`const ${name} = `);
  expect(start, name).toBeGreaterThan(-1);
  const next = src.indexOf('\n  const ', start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

/** Every `const handleX = ` at the top level of the component that contains `needle`. */
function handlersContaining(needle: RegExp): string[] {
  return [...src.matchAll(/\n  const (\w+) = [^\n]*/g)].map(m => m[1]).filter(name => needle.test(handler(name)));
}

const REPLACE_CALL = /resetDocument\(\)|allowOverwrite\(\)|replaceWithHtml\(/;

describe('flows that replace the open document end its tie to a .docx import', () => {
  it.each([
    ['handleNewManuscript', /resetDocument\(\)/],
    ['handleApplyGrantTemplate', /allowOverwrite\(\)/],
    ['handleLoadWorkspace', /allowOverwrite\(\)/],
    ['handleImportText', /allowOverwrite\(\)/],
    ['handleRestoreSnapshot', /replaceWithHtml\(/],
  ])('%s', (name, call) => {
    expect(handler(name)).toMatch(call);
  });

  it('every handler that puts HTML into the editor is either a listed replace flow or a listed edit of the same document', () => {
    // An edit (append a bibliography, undo an applied suggestion) changes the open document in place and keeps its identity.
    const edits = ['handleAnalyzeSection', 'handleRevertHistory'];
    const putsHtml = handlersContaining(/editorRef\.current\?\.setContent\(/);
    expect(putsHtml.length).toBeGreaterThanOrEqual(6);
    for (const name of putsHtml) {
      if (edits.includes(name)) continue;
      expect(handler(name), `${name} replaces the document with HTML but does not end its tie to the import`).toMatch(REPLACE_CALL);
    }
    expect(putsHtml).toEqual(expect.arrayContaining(['handleRestoreSnapshot', 'handleImportText', 'handleNewManuscript', 'handleApplyGrantTemplate', 'handleLoadWorkspace']));
  });

  it('the replace calls are used by exactly these handlers (a new flow must be added here)', () => {
    expect(handlersContaining(REPLACE_CALL).sort()).toEqual(['handleApplyGrantTemplate', 'handleImportText', 'handleLoadWorkspace', 'handleNewManuscript', 'handleRestoreSnapshot']);
  });

  it('the "has content" checks use the exact blank test, not a prefix match that treats work typed into the placeholder as nothing', () => {
    expect(src).not.toMatch(/replace\(\/Start writing your manuscript here/);
    expect(handler('handleImportText')).toMatch(/isBlankText\(/);
    expect(src).toMatch(/documentHasContent=\{!isBlankText\(/);
  });
});
