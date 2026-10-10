import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { getSpecSchema } from '../../../../src/extensions/schemaSpecs';
import { flattenDoc } from '../../../../src/utils/textMatch';
import type { ReviewFixture } from './types';

const text = (t: string): JSONContent[] => (t ? [{ type: 'text', text: t }] : []);

export function fixtureDocJson(fx: ReviewFixture): JSONContent {
  const content: JSONContent[] = [];
  for (const s of fx.sections) {
    content.push({ type: 'heading', attrs: { level: s.level }, content: text(s.title) });
    for (const para of s.paragraphs) content.push({ type: 'paragraph', content: text(para) });
  }
  return { type: 'doc', content };
}

export function fixtureDoc(fx: ReviewFixture): PMNode {
  return getSpecSchema().nodeFromJSON(fixtureDocJson(fx));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fixtureHtml(fx: ReviewFixture): string {
  return fx.sections
    .map(s => `<h${s.level}>${esc(s.title)}</h${s.level}>` + s.paragraphs.map(p => `<p>${esc(p)}</p>`).join(''))
    .join('');
}

/** The same plain text the app sends to the current pipeline (`editorRef.getPlainText()` = flattenDoc). */
export function fixturePlainText(fx: ReviewFixture): string {
  return flattenDoc(fixtureDoc(fx)).text;
}
