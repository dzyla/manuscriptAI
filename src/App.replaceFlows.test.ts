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

describe('flows that replace the open document end its tie to a .docx import', () => {
  it.each([
    ['handleNewManuscript', /resetDocument\(\)/],
    ['handleApplyGrantTemplate', /allowOverwrite\(\)/],
    ['handleLoadWorkspace', /allowOverwrite\(\)/],
    ['handleImportText', /allowOverwrite\(\)/],
  ])('%s', (name, call) => {
    expect(handler(name)).toMatch(call);
  });

  it('the handlers above are the only users of the replace calls (a new flow must be added here)', () => {
    const users = [...src.matchAll(/\n  const (handle\w+) = [^\n]*/g)]
      .map(m => m[1])
      .filter(name => /allowOverwrite\(\)|resetDocument\(\)/.test(handler(name)));
    expect(users.sort()).toEqual(['handleApplyGrantTemplate', 'handleImportText', 'handleLoadWorkspace', 'handleNewManuscript']);
  });
});
