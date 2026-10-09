// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { getSchemaExtensions, htmlToDoc } from '../../extensions/schema';
import { sectionText, findHeadingPos, findCitationPos, idsInOrder } from './docQueries';

const doc = (html: string) => new Editor({ extensions: getSchemaExtensions(), content: htmlToDoc(html) }).state.doc;

describe('docQueries', () => {
  it('sectionText returns the title and the blocks up to the next H2', () => {
    const d = doc('<h2>Intro</h2><p>One.</p><p>Two.</p><h2>Methods</h2><p>Three.</p>');
    expect(sectionText(d, 'Intro')).toBe('Intro\n\nOne.\n\nTwo.');
    expect(sectionText(d, 'Methods')).toBe('Methods\n\nThree.');
    expect(sectionText(d, 'Nowhere')).toBe('Nowhere');
  });

  it('findHeadingPos finds a heading by exact text and is null otherwise', () => {
    const d = doc('<h2>Intro</h2><p>One.</p><h3>Detail</h3>');
    expect(findHeadingPos(d, 'Intro')).toBe(0);
    expect(findHeadingPos(d, 'Detail')).toBeGreaterThan(0);
    expect(findHeadingPos(d, 'Missing')).toBeNull();
  });

  it('findCitationPos finds legacy [N] groups, including ranges', () => {
    const d = doc('<p>A claim [1] and another [2-4] here.</p>');
    expect(findCitationPos(d, 1)).not.toBeNull();
    expect(findCitationPos(d, 3)).toBe(findCitationPos(d, 2));
    expect(findCitationPos(d, 9)).toBeNull();
  });

  it('idsInOrder is empty for a document with neither', () => {
    const d = doc('<p>Nothing here.</p>');
    expect(idsInOrder(d, 'citation')).toEqual([]);
    expect(idsInOrder(d, 'figureLabel')).toEqual([]);
  });
});
