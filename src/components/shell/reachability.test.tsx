// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { RailTask } from './Rail';

// Environment stand-ins, not feature stubs: pdfjs needs canvas, Worker and layout do not exist in jsdom. Nothing a row looks for is faked.
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn(), version: 'test' }));
// The literature-search service is the network. It returns two canned papers so the result list, "Add source" and the PDF-match trio can be reached.
vi.mock('../../services/ai', async (orig) => ({ ...(await orig<typeof import('../../services/ai')>()), getThesaurus: vi.fn(async () => ['SYNONYM_X']) }));
vi.mock('../../services/manuscriptSearch', async (orig) => {
  const real = await orig<typeof import('../../services/manuscriptSearch')>();
  const paper = (n: number) => ({ title: `Mock paper ${n} on screens`, authors: `Author${n} A, Other B`, journal: 'Journal X', doi: `10.1000/mock${n}`, abstract: 'An abstract.', year: 2020 + n, score: 0.9, source: 'PubMed' });
  return { ...real, searchSimilarManuscripts: vi.fn(async () => [paper(1), paper(2)]) };
});
vi.mock('file-saver', () => ({ saveAs: vi.fn() })); // a download is an assertion target here, not a browser action
import { saveAs } from 'file-saver';
import { FIGURE_PROMPTS } from '../editor/figurePrompts';
import App from '../../App';
import { db } from '../../db/manuscriptDb';
import { useAIStore } from '../../stores/useAIStore';
import { useSourceStore, flushPersist } from '../../stores/useSourceStore';
import { useDocumentStore, documentRepository } from '../../stores/useDocumentStore';
import { readDocx } from '../../docx/read';
import { expose } from 'comlink';
import { undoDepth } from '@tiptap/pm/history';
import { readForImport } from '../../workers/docxImportCore';
import { loadDocx } from '../../test/docxFixtures';
import { htmlToDoc } from '../../extensions/schema';
import { createFormat } from '../../services/formatPresets';
import { buildProfile } from '../../services/proseAudit/profile';
import { autocompleteKey } from '../../extensions/AutoComplete';

class InertWorker { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }
/** The import worker runs the real reader (`readForImport`) behind a MessageChannel, so an import in these tests parses a real .docx. Every other worker is inert. */
class TestWorker {
  constructor(url: URL | string) {
    if (!String(url).includes('docxImportWorker')) return new InertWorker() as any;
    const ch = new MessageChannel();
    // the buffer arrives from Node's structured clone, a different realm from this jsdom one; the zip reader only knows its own
    expose({ read: (data: ArrayBuffer, name: string, onStage?: any) => { const own = new ArrayBuffer(data.byteLength); new Uint8Array(own).set(new Uint8Array(data)); return readForImport(own, name, onStage); } }, ch.port1 as any);
    return Object.assign(ch.port2, { terminate: () => ch.port1.close() }) as any;
  }
}
const noRects: any = () => Object.assign([], { item: () => null });
beforeAll(() => {
  (globalThis as any).Worker = TestWorker;
  // Any real network call is a test failure of its own: the app must degrade, not reach out. Crossref, AI providers and pdfjs all land here.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in reachability tests'); }));
  // jsdom's Blob has no text()/arrayBuffer(); the app's file handlers call them.
  const readAs = (b: Blob, how: 'readAsText' | 'readAsArrayBuffer') => new Promise<any>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r[how](b); });
  if (!Blob.prototype.text) Blob.prototype.text = function (this: Blob) { return readAs(this, 'readAsText'); };
  if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function (this: Blob) { return readAs(this, 'readAsArrayBuffer'); };
  Element.prototype.scrollIntoView = () => {};
  for (const p of [Range.prototype, Element.prototype, Text.prototype] as any[]) p.getClientRects = noRects;
  (Range.prototype as any).getBoundingClientRect = () => new DOMRect();
});
afterEach(cleanup);

/**
 * THE MIGRATION CONTRACT. Every feature reachable before the restructure stays reachable after it. A feature that MOVES
 * updates its row here; a feature that becomes unreachable fails this suite. A feature missing from this list cannot be caught.
 *
 * `path` is its destination, walked left to right against the real, mounted App:
 *   rail:<task>      open that rail task (never toggles an open panel shut)
 *   section:<id>     click data-testid="section-<id>"      topbar:<id>   click data-testid="topbar-<id>"
 *   item:<id> / control:<id> / row:<kind>   data-testid="item-<id>" / "control-<id>" / "row-<kind>"
 *   figure:selected  a figure is selected (the "Figure AI" bar is up)
 * `pending: N` = Task N gives the feature its new home. The suite then resolves `now` (its current home) instead, so a feature
 * cannot vanish between tasks. Task 9 asserts nothing is pending. `isNew` = no UI exists today (nothing to lose meanwhile).
 * `now` steps also accept: title:/text:/ph: (exact, or a trailing * for a prefix; #n picks the nth match), icon:<lucide name>,
 * nextto:<text>, fill:<text> (types into the chat box), key:@ (keydown in the editor). The last step is only checked, never clicked.
 * `seed` sets up state the feature needs (a suggestion, a source, a selection) and is documented under `seedAfter`.
 *
 * What a passing row proves: the control is in the mounted App, visible to a person at desktop width, and enabled. Where a row ends in `expect:`/`count:`/`gone:` it also
 * proves the action took effect. A row that ends at a control (an upload, Send) is NOT evidence the feature works: the PDF parser is stubbed (pdfjs needs canvas), the
 * network is refused, and a Word import is the only worker path that runs for real. Treat those rows as "the way in has not been lost", nothing more.
 * `text:` never matches inside the document (a heading typed in the editor cannot stand in for a control). `ptext:` matches only inside the open panel, `htext:` the top bar,
 * `ctext:` the page canvas (the Editor's own stats bar and menus), `stext:` the status bar, `mtext:` a modal overlay.
 */
export type Seed = 'cited-text' | 'saved-doc' | 'voice-profile' | 'table' | 'advisory' | 'local-model' | 'import' | 'snapshot' | 'grant' | 'suggestion' | 'history' | 'sources' | 'citations' | 'outline' | 'analyzing' | 'style-text' | 'text-selection' | 'word-selection' | 'figure' | 'many-suggestions' | 'chat-suggestions';
export interface EntryPoint { feature: string; path: string[]; pending?: number; now?: string[]; isNew?: true; seed?: Seed[] }

const W = 'rail:write', C = 'rail:cite', R = 'rail:review', F = 'rail:format';
const row = (feature: string, path: string[], pending?: number, now?: string[], seed?: Seed[]): EntryPoint =>
  ({ feature, path, ...(pending ? { pending } : {}), ...(now ? { now } : {}), ...(seed ? { seed } : {}) });

export const ENTRY_POINTS: EntryPoint[] = [
  // Write
  row('see the outline', [W, 'section:outline'], undefined, undefined, ['outline']),
  row('jump to a heading from the outline', [W, 'section:outline', 'cursor:30', 'control:goto-heading', 'expect:cursor:1'], undefined, undefined, ['outline']),
  row('analyze one section from the outline', [W, 'section:outline', 'control:analyze-section'], undefined, undefined, ['outline']),
  row('see applied-suggestion history', [W, 'section:history'], undefined, undefined, ['history']),
  row('inspect an applied change', [W, 'section:history', 'control:show-changes'], undefined, undefined, ['history']),
  row('revert an applied change', [W, 'section:history', 'control:revert-change'], undefined, undefined, ['history']),
  row('restore a version snapshot', [W, 'section:versions', 'control:restore-version'], undefined, undefined, ['snapshot']),
  row('restore from the snapshot preview', [W, 'section:versions', 'control:preview-version', 'control:restore-from-preview'], undefined, undefined, ['snapshot']),
  row('close the snapshot preview', [W, 'section:versions', 'control:preview-version', 'control:close-preview'], undefined, undefined, ['snapshot']),
  row('save a version snapshot', [W, 'section:versions', 'control:save-version']),
  row('preview a version snapshot', [W, 'section:versions', 'control:preview-version'], undefined, undefined, ['snapshot']),
  row('delete a version snapshot', [W, 'section:versions', 'control:delete-version'], undefined, undefined, ['snapshot']),
  // The top-bar version-history popup (the live component; the Write panel's Versions section is a second route to the same table)
  row('open the version-history popup', ['title:Version History']),
  row('save a snapshot from the popup', ['title:Version History', 'title:Save snapshot']),
  row('name a snapshot in the popup', ['title:Version History', 'title:Save snapshot', 'title:Save with this name']),
  row('preview a snapshot from the popup', ['title:Version History', 'title:Preview'], undefined, undefined, ['snapshot']),
  row('restore a snapshot from the popup', ['title:Version History', 'title:Restore'], undefined, undefined, ['snapshot']),
  row('delete a snapshot from the popup', ['title:Version History', 'title:Delete'], undefined, undefined, ['snapshot']),
  // Cite
  row('upload a PDF, DOCX, BibTeX or text source', [C, 'section:library', 'control:upload']),
  row('add a source by DOI', [C, 'section:library', 'typein:10.1234/journal.article|10.1000/xyz', 'control:doi']),
  row('remove a source', [C, 'section:library', 'control:remove-source'], undefined, undefined, ['sources']),
  row('regenerate a source summary', [C, 'section:library', 'control:regenerate-summary'], undefined, undefined, ['sources']),
  row('copy a source as BibTeX', [C, 'section:library', 'control:copy-bibtex'], undefined, undefined, ['sources']),
  row('compare a source with the manuscript', [C, 'section:library', 'control:compare-source'], undefined, undefined, ['sources']),
  row('chat about one source', [C, 'section:library', 'control:chat-source'], undefined, undefined, ['sources']),
  row('check a source against the citations', [C, 'section:library', 'control:check-citations'], undefined, undefined, ['sources']),
  row('find the published record of a PDF', [C, 'section:library', 'typein:Search paper title or keywords…|crispr screens', 'control:match-pdf'], undefined, undefined, ['sources']),
  row('search the literature', [C, 'section:search', 'control:query']),
  row('format a bibliography from a BibTeX source', [C, 'section:references', 'control:format-bibliography'], undefined, undefined, ['sources']),
  row('renumber citations', [C, 'section:references', 'control:renumber'], undefined, undefined, ['sources', 'citations']),
  row('search the reference list', [C, 'section:references', 'control:filter-references'], undefined, undefined, ['sources', 'citations']),
  row('jump to a citation in the document', [C, 'section:references', 'control:goto-citation'], undefined, undefined, ['sources', 'citations']),
  row('jump to the first citation of a source', [C, 'section:references', 'control:first-citation'], undefined, undefined, ['sources', 'citations']),
  row('remove a citation', [C, 'section:references', 'control:remove-citation'], undefined, undefined, ['sources', 'citations']),
  row('insert the reference list', [C, 'section:references', 'control:insert-reference-list'], undefined, undefined, ['sources', 'citations']),
  row('insert a citation with @', ['topbar:insert', 'item:citation', 'text:Insert Citation']),
  // Review
  row('open chat', [R, 'section:chat']),
  row('send a chat message', [R, 'section:chat', 'fill:hello', 'control:send']),
  row('switch between Manuscript AI and agents', [R, 'section:chat', 'control:agent-mode']),
  row('read what each agent does', [R, 'section:chat', 'control:agent-info']),
  row('attach an image to a chat message', [R, 'section:chat', 'control:attach-image']),
  row('choose which sources the chat sees', [R, 'section:chat', 'control:attach-sources']),
  row('accept a suggestion', [R, 'row:suggestion', 'control:accept'], undefined, undefined, ['suggestion', 'outline']),
  row('reject a suggestion', [R, 'row:suggestion', 'control:reject'], undefined, undefined, ['suggestion']),
  row('accept every suggestion', [R, 'control:accept-all'], undefined, undefined, ['suggestion']),
  row('clear every suggestion', [R, 'control:reject-all'], undefined, undefined, ['suggestion']),
  row('disagree with a suggestion and reply', [R, 'row:suggestion', 'control:rebut'], undefined, undefined, ['suggestion']),
  row('rewrite a flagged sentence', [R, 'row:style', 'control:rewrite'], undefined, undefined, ['style-text']),
  row('jump to a flagged sentence', [R, 'row:style', 'control:goto'], undefined, undefined, ['style-text']),
  row('read the style comparison', [R, 'section:style']),
  row('add writing samples for the voice profile', [R, 'section:style', 'control:voice-samples']),
  row('filter suggestions by severity', [R, 'control:filter'], undefined, undefined, ['suggestion']),
  row('reset the severity filter', [R, 'control:filter', 'control:filter-all'], undefined, undefined, ['suggestion']),
  row('show more review items', [R, 'control:show-more'], undefined, undefined, ['many-suggestions']),
  row('stop a request from the chat', [R, 'section:chat', 'title:Stop request'], undefined, undefined, ['analyzing']),
  row('accept a suggestion from a chat card', [R, 'section:chat', 'control:card-accept'], undefined, undefined, ['chat-suggestions']),
  row('reject a suggestion from a chat card', [R, 'section:chat', 'control:card-reject'], undefined, undefined, ['chat-suggestions']),
  row('insert an advisory note from a chat card', [R, 'section:chat', 'control:card-insert-note'], undefined, undefined, ['chat-suggestions']),
  row('dismiss an advisory from a chat card', [R, 'section:chat', 'control:card-dismiss'], undefined, undefined, ['chat-suggestions']),
  row('run an analysis', [R, 'control:analyze']),
  row('stop a running analysis', [R, 'control:stop'], undefined, undefined, ['analyzing']),
  row('run one named agent', [R, 'control:analyze-agent', 'control:analyze-agent-one']),
  row('clear the reference search', [C, 'section:references', 'typein:Search references…|zz', 'control:clear-reference-filter'], undefined, undefined, ['sources', 'citations']),
  row('filter suggestions to one severity', [R, 'control:filter', 'control:filter-severity'], undefined, undefined, ['suggestion']),
  row('run a single agent', [R, 'control:analyze-agent']),
  row('summarize the manuscript and its gaps', [R, 'control:summary']),
  // Format
  row('pick a grant template', [F, 'section:template', 'control:template', 'css:[aria-label="Choose grant template"]']),
  row('edit grant instructions', [F, 'section:template', 'control:instructions', 'css:[aria-label="Grant instructions"]']),
  row('see grant section page budgets', [F, 'section:template', 'control:budgets'], undefined, undefined, ['grant']),
  row('trim an over-budget section', [F, 'section:template', 'control:trim'], undefined, undefined, ['grant']),
  row('switch between manuscript and grant mode', [F, 'section:template', 'control:mode']),
  row('set page margins', [F, 'section:page', 'control:margin-left']),
  row('choose a format preset', [F, 'section:page', 'control:preset']),
  row('edit a named style', [F, 'section:styles', 'control:style-size-normal']),
  // New in Task 7: nothing existed to lose. The limit is the author's own number, never one the app supplies.
  row('set the document page limit', [F, 'section:page', 'control:page-limit']),
  row('undo a format preset', [F, 'section:page', 'choose:Manuscript: Letter, Times, double spaced', 'control:preset-undo']),
  row('choose the paper size', [F, 'section:page', 'control:page-size']),
  row('set the body font size', [F, 'section:page', 'control:body-font-size']),
  // File and document (top bar)
  row('start a new manuscript', ['topbar:file', 'item:new']),
  row('import a Word, JSON, Markdown or text file', ['topbar:file', 'item:import']),
  row('see the import report again', ['topbar:file', 'item:import-report'], undefined, undefined, ['import']),
  row('restore the previous document', ['topbar:file', 'item:revert-import'], undefined, undefined, ['import']),
  row('save a workspace file', ['topbar:file', 'item:save-workspace']),
  row('export Markdown', ['topbar:file', 'item:export-md']),
  row('export Word', ['topbar:file', 'item:export-docx']),
  row('export LaTeX', ['topbar:file', 'item:export-tex']),
  row('undo', ['topbar:file', 'item:undo']),
  row('redo', ['topbar:file', 'item:redo']),
  row('rename the document', ['topbar:title']),
  row('open settings', ['topbar:overflow', 'item:settings', 'text:AI Configuration']),
  row('draft a rebuttal or cover letter', ['topbar:overflow', 'item:post-drafting', 'text:Post-Drafting Assistant']),
  row('read the keyboard shortcuts', ['topbar:overflow', 'item:shortcuts', 'mtext:Ctrl+Shift+A']),
  row('toggle dark mode', ['topbar:overflow', 'item:dark-mode']),
  row('enter focus mode', ['topbar:overflow', 'item:focus-mode']),
  row('zoom out', ['topbar:overflow', 'item:zoom-out']),
  row('zoom in', ['topbar:overflow', 'item:zoom-in']),
  // Status
  row('read the page estimate', ['status:pages'], undefined, undefined),
  row('read the word count', ['status:words'], undefined, undefined),
  row('read the save state', ['status:save'], undefined, undefined),
  row('read the token estimate and provider', ['status:tokens']),
  row('read characters, paragraphs and reading time', ['status:stats']),
  row('analyze the section the cursor is in', ['topbar:ai', 'item:analyze-section'], undefined, undefined, ['outline']),
  // Text formatting and insert (top bar)
  // Format text: the selection bar's inline marks, block type and alignment (it shows only while text is selected, hence the seed). Each row ends in the effect, not just the control.
  ...['bold', 'italic', 'underline'].map(m => row(`format text: ${m}`, [`control:${m}`, `expect:${m}`], undefined, undefined, ['text-selection'])),
  ...[['heading 2', 'Heading 2', 'heading2'], ['heading 3', 'Heading 3', 'heading3'], ['bullet list', 'Bullet list', 'bulletList'], ['numbered list', 'Numbered list', 'orderedList'], ['blockquote', 'Quote', 'blockquote'],
  ].map(([f, opt, e]) => row(`format text: ${f}`, ['control:block-type', `choose:${opt}`, `expect:${e}`], undefined, undefined, ['text-selection'])),
  row('format text: align left', ['control:align', 'choose:Center', 'choose:Align left', 'expect:align-left'], undefined, undefined, ['text-selection']),
  row('format text: center text', ['control:align', 'choose:Center', 'expect:align-center'], undefined, undefined, ['text-selection']),
  row('format text: justify text', ['control:align', 'choose:Justify', 'expect:align-justify'], undefined, undefined, ['text-selection']),
  row('toggle AI autocomplete', ['topbar:ai', 'item:autocomplete']),
  row('insert a figure', ['topbar:insert', 'item:figure']),
  row('insert a figure label', ['topbar:insert', 'item:figure-label', 'expect:node:figureLabel']),
  row('insert a table', ['topbar:insert', 'item:table', 'css:#table-picker-portal']),
  // AI on the selection
  ...['Polish', 'Shorten', 'Sharpen', 'Strengthen', 'Critique', 'Explain'].map(l =>
    row(`${l.toLowerCase()} the selection`, ['topbar:ai', `item:${l.toLowerCase()}`], undefined, undefined, ['text-selection'])),
  row('rewrite the selection', ['topbar:ai', 'item:rewrite'], undefined, undefined, ['text-selection']),
  row('give a custom instruction', ['topbar:ai', 'item:instruct'], undefined, undefined, ['text-selection']),
  row('find synonyms', ['topbar:ai', 'item:synonyms'], undefined, undefined, ['word-selection']),
  row('verify a claim against sources', ['topbar:ai', 'item:verify'], undefined, undefined, ['text-selection']),
  row('replace a word with a synonym', ['topbar:ai', 'item:synonyms', 'item:synonym-choice', 'expect:doctext:SYNONYM_X'], undefined, undefined, ['word-selection']),
  row('bold the selection from the selection menu', ['control:bold', 'expect:bold'], undefined, undefined, ['text-selection']),
  row('italicize the selection from the selection menu', ['control:italic', 'expect:italic'], undefined, undefined, ['text-selection']),
  row('underline the selection from the selection menu', ['control:underline', 'expect:underline'], undefined, undefined, ['text-selection']),
  row('send a custom instruction', ['topbar:ai', 'item:instruct', 'item:instruct-send'], undefined, undefined, ['text-selection']),
  row('find similar manuscripts', ['topbar:ai', 'item:similar'], undefined, undefined, ['text-selection']),
  // AI and layout on the selected figure
  row('describe a figure', ['figure:selected', 'control:describe'], undefined, undefined, ['figure']),
  row('check figure quality', ['figure:selected', 'control:quality'], undefined, undefined, ['figure']),
  row('review figure relevance', ['figure:selected', 'control:relevance'], undefined, undefined, ['figure']),
  row('type a question about a figure', ['figure:selected', 'control:ask', 'control:ask-text'], undefined, undefined, ['figure']),
  row('ask about a figure', ['figure:selected', 'control:ask'], undefined, undefined, ['figure']),
  row('align a figure', ['figure:selected', 'control:align-figure', 'expect:figalign:left'], undefined, undefined, ['figure']),
  row('resize a figure', ['figure:selected', 'control:size-figure', 'expect:figwidth:25%'], undefined, undefined, ['figure']),
  row('delete a figure', ['figure:selected', 'control:delete-figure', 'expect:nofigure'], undefined, undefined, ['figure']),

  // ── Round 1: the interactions, keyboard bindings and Cite/Editor details the first pass left out ──
  // Cite
  row('run a literature search', [C, 'section:search', 'typein:Title, keywords, or paste abstract…|crispr screens', 'control:run-search', 'ptext:Mock paper 1 on screens']),
  row('add a search result to the library', [C, 'section:search', 'typein:Title, keywords, or paste abstract…|crispr screens', 'control:run-search', 'control:add-result', 'expect:source:Mock paper 1 on screens']),
  row('choose the bibliography style', [C, 'section:references', 'control:bib-style', 'select:Vancouver'], undefined, undefined, ['sources']),
  row('sort the reference list', [C, 'section:references', 'control:sort-references', 'select:Year'], undefined, undefined, ['sources', 'citations']),
  row('expand a reference row', [C, 'section:references', 'control:expand-reference', 'ptext:Less'], undefined, undefined, ['sources', 'citations']),
  row('confirm a PDF match', [C, 'section:library', 'typein:Search paper title or keywords…|crispr screens', 'control:match-pdf', 'control:match-yes', 'expect:source:Mock paper 1 on screens'], undefined, undefined, ['sources']),
  row('try the next PDF match', [C, 'section:library', 'typein:Search paper title or keywords…|crispr screens', 'control:match-pdf', 'control:match-next', 'ptext:Is this your paper? (2/2)'], undefined, undefined, ['sources']),
  row('dismiss a PDF match', [C, 'section:library', 'typein:Search paper title or keywords…|crispr screens', 'control:match-pdf', 'control:match-dismiss', 'gone:Is this your paper?*'], undefined, undefined, ['sources']),
  row('switch a PDF between summary and abstract', [C, 'section:library', 'control:source-tabs', 'ptext:abstract#1', 'ptext:abs'], undefined, undefined, ['sources']),
  row('re-extract a PDF abstract', [C, 'section:library', 'ptext:abstract#1', 'control:reextract-abstract'], undefined, undefined, ['sources']),
  row('drop files on the sources area', [C, 'section:library', 'control:dropzone', 'dropcss:[data-testid="control-dropzone"]|notes.txt', 'ptext:notes.txt']),
  // Review (chat and suggestions)
  row('attach one source to a chat message', [R, 'section:chat', 'control:attach-sources', 'control:attach-one-source'], undefined, undefined, ['sources']),
  row('limit chat to the whole manuscript', [R, 'section:chat', 'control:attach-sources', 'control:scope-full', 'count:Full Manuscript=1']),
  row('limit chat to the current section', [R, 'section:chat', 'control:attach-sources', 'control:scope-section', 'count:Current Section=2']),
  row('choose which agent replies', [R, 'section:chat', 'control:agent-mode', 'ptext:Reviewer 2', 'expect:agent:Reviewer 2']),
  row('send a chat message with Enter', [R, 'section:chat', 'fill:hello', 'keyin:Enter', 'expect:message:hello']),
  row('drop an image into chat', [R, 'section:chat', 'dropcss:aside textarea|pic.png', 'title:pic.png']),
  row('paste an image into chat', [R, 'section:chat', 'pastecss:aside textarea|pic.png', 'title:pic.png']),
  row('dismiss the vision warning', [R, 'section:chat', 'dropcss:aside textarea|pic.png', 'ptext:*may not support vision*', 'control:vision-warning', 'gone:*may not support vision*'], undefined, undefined, ['local-model']),
  row('send a rebuttal to a suggestion', [R, 'row:suggestion', 'control:rebut', 'typein:Explain why you disagree with this suggestion...|because', 'control:send-rebuttal'], undefined, undefined, ['suggestion']),
  row('cancel a rebuttal', [R, 'row:suggestion', 'control:rebut', 'control:cancel-rebuttal'], undefined, undefined, ['suggestion']),
  row('switch back to Manuscript AI chat', [R, 'section:chat', 'control:agent-mode', 'control:chat-mode']),
  row('click a suggestion to find it in the text', [R, 'row:suggestion', 'control:locate', 'expect:selection:Alpha'], undefined, undefined, ['suggestion', 'outline']),
  row('insert an advisory suggestion as a note', [R, 'row:suggestion', 'control:insert-note'], undefined, undefined, ['advisory', 'outline']),
  row('dismiss an advisory suggestion', [R, 'row:suggestion', 'control:dismiss'], undefined, undefined, ['advisory']),
  row('click an applied change to find it in the text', [W, 'section:history', 'control:locate-change', 'expect:selection:beta gamma'], undefined, undefined, ['history', 'outline']),
  row('run an analysis from the top bar', ['topbar:ai', 'item:analyze']),
  row('run a single agent from the top bar', ['topbar:ai', 'item:analyze-agent']),
  row('run one named agent from the top bar', ['topbar:ai', 'item:analyze-agent', 'item:analyze-agent-one']),
  row('summarize from the top bar', ['topbar:ai', 'item:summary']),
  row('stop an analysis from the top bar', ['topbar:ai', 'item:stop'], undefined, undefined, ['analyzing']),
  row('confirm the export warning and download', ['topbar:file', 'item:export-md', 'control:export-confirm']),
  row('cancel the export warning', ['topbar:file', 'item:export-md', 'control:export-cancel']),
  row('close the shortcuts list', ['topbar:overflow', 'item:shortcuts', 'control:shortcuts-close']),
  row('measure my voice from pasted samples', [R, 'section:style', 'control:voice-samples', 'control:voice-measure']),
  row('cancel adding voice samples', [R, 'section:style', 'control:voice-samples', 'control:voice-cancel']),
  row('rebuild the voice profile', [R, 'section:style', 'control:voice-rebuild'], undefined, undefined, ['voice-profile']),
  row('remove the voice profile', [R, 'section:style', 'control:voice-remove'], undefined, undefined, ['voice-profile']),
  // Editor internals that stay in the Editor: their rows are settled, so a move must edit the row
  row('click a highlighted passage to open its suggestion', ['rail:cite', 'markclick:', 'ptext:Accept'], undefined, undefined, ['suggestion', 'outline']),
  row('pick a table size', ['topbar:insert', 'item:table', 'css:#table-picker-portal div[style*="cursor"]#9', 'expect:table:2x3']),
  row('add a table column before', ['contextmenu:', 'text:*Add column before', 'expect:table:2x3'], undefined, undefined, ['table']),
  row('add a table column after', ['contextmenu:', 'text:*Add column after', 'expect:table:2x3'], undefined, undefined, ['table']),
  row('add a table row above', ['contextmenu:', 'text:*Add row above', 'expect:table:3x2'], undefined, undefined, ['table']),
  row('add a table row below', ['contextmenu:', 'text:*Add row below', 'expect:table:3x2'], undefined, undefined, ['table']),
  row('delete a table column', ['contextmenu:', 'text:*Delete column', 'expect:table:2x1'], undefined, undefined, ['table']),
  row('delete a table row', ['contextmenu:', 'text:*Delete row', 'expect:table:1x2'], undefined, undefined, ['table']),
  row('delete a table', ['contextmenu:', 'text:*Delete table', 'expect:notable'], undefined, undefined, ['table']),
  row('choose a source in the @ picker', ['key:@', 'text:paper', 'expect:node:citation'], undefined, undefined, ['sources']),
  row('look up a DOI typed after @', ['key:@', 'type:@10.1000/abc', 'text:Look up DOI via Crossref']),
  row('look up several DOIs typed after @', ['key:@', 'type:@10.1000/abc1,10.1000/abc2', 'text:Look up 2 DOIs via Crossref']),
  row('insert a typed DOI with Space', ['key:@', 'type:@10.1000/abc', 'keyhandled: ']),
  row('insert several typed DOIs with Space', ['key:@', 'type:@10.1000/abc1,10.1000/abc2', 'keyhandled: ']),
  row('dismiss a failed DOI lookup', ['key:@', 'type:@10.1000/abc', 'keyhandled: ', 'text:Dismiss']),
  row('close the @ picker with Escape', ['key:@', 'text:Insert Citation', 'key:Escape', 'gone:Insert Citation']),
  row('choose the agent for a custom instruction', ['topbar:ai', 'item:instruct', 'select:Reviewer 2'], undefined, undefined, ['text-selection']),
  row('type a custom instruction', ['topbar:ai', 'item:instruct', 'item:instruct-text'], undefined, undefined, ['text-selection']),
  row('read the character count', ['status:chars']),
  row('read the paragraph count', ['status:paragraphs']),
  row('resize the side panel', [R, 'css:.cursor-col-resize', 'drag:-100', 'expect:panelwidth:500px']),
  // Keyboard bindings: independently losable, so each has its own row
  row('use the restore button on the import message', ['topbar:file', 'item:import', 'importdocx:body-basics.docx', 'control:toast-action', 'text:*Restored the document the import replaced*'], undefined, undefined, ['saved-doc']),
  row('save the workspace with Ctrl/Cmd+S', ['keyhandled:Mod+S']),
  row('analyze with Ctrl/Cmd+Shift+A', ['keyhandled:Mod+Shift+A']),
  row('show the shortcuts with Ctrl/Cmd+?', ['key:Mod+?', 'mtext:Ctrl+Shift+A']),
  row('bold with Ctrl+B', ['key:Ctrl+B', 'expect:bold'], undefined, undefined, ['text-selection']),
  row('italic with Ctrl+I', ['key:Ctrl+I', 'expect:italic'], undefined, undefined, ['text-selection']),
  row('underline with Ctrl+U', ['key:Ctrl+U', 'expect:underline'], undefined, undefined, ['text-selection']),
  // New in Task 8: routes that did not exist before the top bar became selection-aware. Each ends in the effect.
  row('choose a source after Insert > Citation', ['topbar:insert', 'item:citation', 'text:paper', 'expect:node:citation'], undefined, undefined, ['sources']),
  row('stop a request from the top bar button', ['topbar:stop'], undefined, undefined, ['analyzing']),
  row('send a question about a figure', ['figure:selected', 'control:ask', 'typein:Ask about this figure…*|what is plotted', 'control:ask-send', 'expect:message:what is plotted'], undefined, undefined, ['figure']),
  row('set the block style at rest', ['topbar:body-style', 'choose:Heading 2', 'expect:heading2']),
  row('add a table row above from the bar', ['control:row-above', 'expect:table:3x2'], undefined, undefined, ['table']),
  row('add a table row below from the bar', ['control:row-below', 'expect:table:3x2'], undefined, undefined, ['table']),
  row('add a table column before from the bar', ['control:col-before', 'expect:table:2x3'], undefined, undefined, ['table']),
  row('add a table column after from the bar', ['control:col-after', 'expect:table:2x3'], undefined, undefined, ['table']),
  row('delete a table row from the bar', ['control:delete-row', 'expect:table:1x2'], undefined, undefined, ['table']),
  row('delete a table column from the bar', ['control:delete-column', 'expect:table:2x1'], undefined, undefined, ['table']),
  row('delete a table from the bar', ['control:delete-table', 'expect:notable'], undefined, undefined, ['table']),
  row('accept autocomplete with Tab', ['ghost: and more words', 'key:Tab', 'expect:doctext: and more words'], undefined, undefined, ['outline']),
];

/** Deliberately not entry points. */
export const EXCLUDED = [
  { feature: 'editorWidth (normal/wide/full)', reason: 'removed by design: the page is the width (spec §2)' },
  { feature: 'second version-history component (VersionHistoryPanel)', reason: 'unused duplicate, deleted in Task 6 (plan), spec §5' },
];

// ── Resolver ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const matches = (a: string, w: string) =>
  w.length > 1 && w.startsWith('*') && w.endsWith('*') ? a.includes(w.slice(1, -1)) : w.endsWith('*') ? a.startsWith(w.slice(0, -1)) : w.startsWith('*') ? a.endsWith(w.slice(1)) : a === w;

/**
 * Whether a person could see and use the element. Hidden by: the `hidden` attribute, aria-hidden, inert, inline display/visibility/opacity/pointer-events,
 * and Tailwind `hidden`, `invisible`, `sr-only`, `opacity-0`, `pointer-events-none`, `w-0`, `h-0`/`max-h-0`/`max-w-0` with `overflow-hidden`, unless the same element
 * carries a responsive/hover/focus variant that reveals it. jsdom has no layout, so a zero-size box from real CSS (not these classes) is not detectable.
 */
export function isShown(el: Element): boolean {
  const BP: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280 }; // desktop-first: jsdom's window is 1024 wide
  const live = (pfx: string) => (pfx in BP ? window.innerWidth >= BP[pfx] : true); // hover and focus variants can happen
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    const st = (e as HTMLElement).style;
    if (e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('inert')) return false;
    if (st?.display === 'none' || st?.visibility === 'hidden' || st?.opacity === '0' || st?.pointerEvents === 'none') return false;
    const cls = (e.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const variants = cls.map(c => /^(sm|md|lg|xl|group-hover|hover|focus|focus-within|group-focus-within):(.+)$/.exec(c)).filter((m): m is RegExpExecArray => !!m).filter(m => live(m[1]));
    const revealed = (family: RegExp) => variants.some(m => family.test(m[2]));
    if (variants.some(m => m[1] in BP && m[2] === 'hidden')) return false; // `sm:hidden`: hidden from that width up
    if (cls.includes('hidden') && !revealed(/^(?:block|flex|inline|inline-block|inline-flex|grid|table)$/)) return false;
    if (cls.includes('invisible') && !revealed(/^visible$/)) return false;
    if (cls.includes('sr-only') && !revealed(/^not-sr-only$/)) return false;
    if (cls.includes('opacity-0') && !revealed(/^opacity-/)) return false;
    if (cls.includes('pointer-events-none') && !revealed(/^pointer-events-auto$/)) return false;
    if (cls.includes('w-0') && !revealed(/^w-/)) return false;
    if (cls.includes('overflow-hidden') && cls.some(c => /^(?:max-h-0|h-0|max-w-0)$/.test(c)) && !revealed(/^(?:max-h|h|max-w)-/)) return false;
  }
  return true;
}

/** Where each text kind looks. `text:` is the whole app minus the document and should be rare; the others name a region, so a label elsewhere cannot answer. */
const SCOPES: Record<string, string> = { ptext: 'aside.u-shell-panel', htext: '.u-shell-top', ctext: '.u-shell-canvas', stext: '.u-shell-status', mtext: '.fixed.inset-0' };
const innermost = (els: Element[]) => els.filter(e => !els.some(o => o !== e && e.contains(o)));
const panelEl = () => document.querySelector('aside.u-shell-panel');
/**
 * `text:` looks at the whole app EXCEPT the document itself (.ProseMirror), so a heading typed into the editor can never stand in for a control.
 * `ptext:` looks only inside the open panel. Both take the innermost element whose whole text matches.
 */
function candidates(kind: string, arg: string): Element[] {
  const m = /#(\d+)$/.exec(arg);
  const want = m ? arg.slice(0, m.index) : arg, nth = m ? Number(m[1]) : 0;
  const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)];
  const textual = (root: ParentNode) => innermost(all('*', root).filter(e => !/^(SCRIPT|STYLE|OPTION|SVG|PATH|TEXTAREA|INPUT)$/i.test(e.tagName) && !e.closest('.ProseMirror') && matches(norm(e.textContent), want)));
  let found: Element[] = [];
  if (kind === 'title') found = all('[title]').filter(e => matches(e.getAttribute('title')!, want));
  else if (kind === 'ph') found = all('[placeholder]').filter(e => matches(e.getAttribute('placeholder')!, want));
  else if (kind === 'testid') found = all('[data-testid]').filter(e => e.getAttribute('data-testid') === want);
  else if (kind === 'icon') found = all(`svg.lucide-${want}`).map(e => e.closest('button') ?? e);
  else if (kind === 'css') found = all(want);
  else if (kind === 'select') found = all('select').filter(sel => [...(sel as HTMLSelectElement).options].some(o => matches(norm(o.textContent), want)));
  else if (kind === 'text') found = textual(document.body);
  else if (kind in SCOPES) { const root = document.querySelector(SCOPES[kind]); found = root ? textual(root) : []; }
  else if (kind === 'nextto') found = innermost(all('button').filter(e => matches(norm(e.textContent), want))).map(e => e.closest('button')!.nextElementSibling).filter((e): e is Element => !!e);
  const shown = found.filter(isShown);
  return nth ? shown.slice(nth - 1, nth) : shown;
}

async function waitStep<T>(label: string, fn: () => T | null | undefined | false): Promise<T> {
  try {
    return await waitFor(() => { const v = fn(); if (!v) throw new Error('missing'); return v; }, { timeout: 4000, interval: 25 });
  } catch { throw new Error(`unreachable: ${label}`); }
}

const enabled = (el: Element) => !(el.closest('button,input,select,textarea') as HTMLButtonElement | null)?.disabled;
/** A real click: some controls act on mousedown (toolbar, table menu, pickers), others on click. */
const click = (el: Element) => { fireEvent.mouseDown(el); fireEvent.mouseUp(el); fireEvent.click(el); };
const editor = () => (document.querySelector('.ProseMirror') as any)?.editor;
const settle = (ms = 150) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const plainFile = (spec: string) => new File(['x'], spec, { type: spec.endsWith('.png') ? 'image/png' : 'text/plain' });
const combo = (c: string, mod: 'ctrl' | 'meta') => {
  const parts = c.split('+'), key = c.endsWith('+') ? '+' : parts[parts.length - 1];
  const has = (n: string) => parts.slice(0, -1).includes(n);
  return { key: key.length === 1 && has('Shift') ? key.toUpperCase() : key.length === 1 && !has('Shift') && /[A-Z]/.test(key) ? key.toLowerCase() : key,
    ctrlKey: has('Ctrl') || (has('Mod') && mod === 'ctrl'), metaKey: has('Meta') || (has('Mod') && mod === 'meta'), shiftKey: has('Shift') || key === '?', bubbles: true, cancelable: true };
};
const tableShape = (ed: any) => { let rows = 0, cols = 0; ed.state.doc.descendants((n: any) => { if (n.type.name === 'table') { rows = n.childCount; cols = n.firstChild?.childCount ?? 0; return false; } return true; }); return rows ? `${rows}x${cols}` : 'none'; };

async function expectation(arg: string) {
  const [name, ...rest] = arg.split(':'), val = rest.join(':');
  const check: Record<string, () => boolean> = {
    table: () => tableShape(editor()) === val, notable: () => tableShape(editor()) === 'none',
    node: () => { let f = false; editor().state.doc.descendants((n: any) => { if (n.type.name === val) f = true; }); return f; },
    selection: () => { const { from, to } = editor().state.selection; return from !== to && editor().state.doc.textBetween(from, to, ' ') === val; },
    cursor: () => editor().state.selection.from === Number(val),
    bold: () => editor().isActive('bold'), italic: () => editor().isActive('italic'), underline: () => editor().isActive('underline'),
    heading1: () => editor().isActive('heading', { level: 1 }), heading2: () => editor().isActive('heading', { level: 2 }), heading3: () => editor().isActive('heading', { level: 3 }),
    bulletList: () => editor().isActive('bulletList'), orderedList: () => editor().isActive('orderedList'), blockquote: () => editor().isActive('blockquote'),
    'align-left': () => editor().isActive({ textAlign: 'left' }), 'align-center': () => editor().isActive({ textAlign: 'center' }), 'align-justify': () => editor().isActive({ textAlign: 'justify' }),
    figalign: () => editor().getAttributes('resizableImage').align === val, figwidth: () => editor().getAttributes('resizableImage').width === val,
    nofigure: () => { let f = false; editor().state.doc.descendants((n: any) => { if (n.type.name === 'resizableImage') f = true; }); return !f; },
    doctext: () => editor().state.doc.textContent.includes(val),
    message: () => JSON.stringify(useAIStore.getState().messages).includes(val),
    source: () => useSourceStore.getState().sources.some(s => s.name === val),
    agent: () => candidates('ptext', val).some(b => (b.closest('button')?.className ?? '').includes('text-white')),
    panelwidth: () => (panelEl()?.firstElementChild as HTMLElement | null)?.style.width === val,
  };
  await waitStep(`expect ${arg}`, () => check[name]?.());
}

let lastDrag = { x: 0 };
async function step(spec: string, isLast: boolean): Promise<void> {
  const i = spec.indexOf(':');
  const kind = spec.slice(0, i), arg = spec.slice(i + 1);
  if (kind === 'rail') {
    const name = arg[0].toUpperCase() + arg.slice(1);
    const btn = await waitStep(spec, () => screen.queryAllByRole('button').find(b => (b.getAttribute('aria-label') ?? '').startsWith(`${name} —`)));
    if (btn.getAttribute('aria-pressed') !== 'true') click(btn); // a pressed task is open already; clicking it would close the panel
    await waitStep(`${spec}: its panel is open and visible`, () => { const a = panelEl(); return a && isShown(a) && a.getAttribute('data-task') === arg; });
    return;
  }
  if (kind === 'section' || kind === 'topbar') {
    const el = await waitStep(spec, () => candidates('testid', `${kind}-${arg}`)[0]);
    if (el.getAttribute('aria-expanded') === 'true') return; // a section that starts open (Library) is reached as it is; clicking it would shut it
    click(el); await settle(0); return;
  }
  if (kind === 'item' || kind === 'control' || kind === 'row') {
    const el = await waitStep(spec, () => candidates('testid', `${kind}-${arg}`)[0]);
    if (!isLast) click(el); else expect(enabled(el), `${spec} is disabled`).toBe(true);
    return;
  }
  if (kind === 'figure') { await waitStep(spec, () => candidates('text', 'Figure AI')[0]); return; }
  if (kind === 'status') {
    const want = { pages: /^~?\d+ (pp|of \d+)$/, words: /^[\d,]+ words$/, save: /^(Draft|Saved|Auto-saved)$/,
      tokens: /^~[\d,]+ tokens$/, chars: /^[\d,]+ chars$/, paragraphs: /^[\d,]+ paragraphs$/, stats: /^\d+ min read$/ }[arg];
    await waitStep(spec, () => want && [...document.querySelectorAll('[role=status] span')].some(s => want.test(norm(s.textContent)) && isShown(s))); return;
  }
  if (kind === 'key') { fireEvent.keyDown(editor().view.dom, combo(arg, 'ctrl')); await settle(0); return; }
  if (kind === 'keyhandled') { // the binding fires: the handler took the event (preventDefault), for Ctrl and for Cmd where the app binds either
    for (const mod of arg.startsWith('Mod+') ? ['ctrl', 'meta'] as const : ['ctrl'] as const) {
      const delivered = fireEvent.keyDown(editor().view.dom, combo(arg, mod));
      expect(delivered, `${arg} (${mod}) was not handled`).toBe(false);
    }
    return;
  }
  if (kind === 'keyin') { const box = await waitStep(spec, () => candidates('css', 'aside textarea')[0]); fireEvent.keyDown(box, { key: arg, bubbles: true }); await settle(0); return; }
  if (kind === 'fill') { const box = await waitStep(spec, () => candidates('css', 'aside textarea')[0]); fireEvent.change(box, { target: { value: arg } }); return; }
  if (kind === 'typein') {
    const [ph, value] = arg.split('|'); const box = await waitStep(spec, () => candidates('ph', ph)[0]);
    fireEvent.change(box, { target: { value } }); return;
  }
  if (kind === 'type') { await act(async () => { editor().commands.insertContent(arg); }); await settle(50); return; }
  if (kind === 'cursor') { await act(async () => { editor().commands.setTextSelection(Number(arg)); }); return; }
  if (kind === 'ghost') { const ed = editor(); await act(async () => { ed.view.dispatch(ed.state.tr.setMeta(autocompleteKey, { suggestion: arg })); }); return; }
  if (kind === 'contextmenu') { await act(async () => { fireEvent.contextMenu(editor().view.dom, { clientX: 5, clientY: 5 }); }); return; }
  if (kind === 'markclick') {
    const ed = editor(); ed.view.posAtCoords = () => ({ pos: 9, inside: -1 }); // jsdom has no layout to map a click to a position
    const mark = await waitStep('a highlighted passage in the text', () => ed.view.dom.querySelector('mark')); click(mark); return;
  }
  if (kind === 'dropcss' || kind === 'pastecss') {
    const [sel, name] = arg.split('|'); const target = await waitStep(spec, () => candidates('css', sel)[0]); const file = plainFile(name);
    if (kind === 'dropcss') fireEvent.drop(target, { dataTransfer: { files: [file], types: ['Files'] } });
    else fireEvent.paste(target, { clipboardData: { items: [{ type: file.type, getAsFile: () => file }] } });
    await settle(50); return;
  }
  if (kind === 'drag') { // the resize handle was the previous step's element, located but not clicked: find it again
    const handle = await waitStep('the resize handle', () => candidates('css', '.cursor-col-resize')[0]);
    fireEvent.mouseDown(handle, { clientX: 500 }); fireEvent.mouseMove(document, { clientX: 500 + Number(arg) }); fireEvent.mouseUp(document); await settle(0); return;
  }
  if (kind === 'importdocx') {
    const input = await waitStep('the file input', () => document.querySelector('input[type=file][accept*=".docx"]')) as HTMLInputElement;
    const file = new File([loadDocx(arg)], arg, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    fireEvent.change(input, { target: { files: [file] } });
    const ok = await waitStep('the import review dialog (the real reader ran)', () => screen.queryAllByRole('button').find(b => /^Import( with .*)?$/.test(norm(b.textContent))));
    click(ok); return;
  }
  if (kind === 'count') { const [t, n] = arg.split('='); await waitStep(`${spec} (clicking it changed what the chat will send)`, () => candidates('ptext', t).length === Number(n)); return; }
  if (kind === 'expect') { await expectation(arg); return; }
  if (kind === 'gone') { await waitStep(`${spec} disappears`, () => Object.keys({ text: 1, ...SCOPES }).every(k => candidates(k, arg).length === 0)); return; }
  if (kind === 'choose') { // pick an option in a <select> and carry on, so a later step can reach what the choice reveals
    const sel = await waitStep(spec, () => candidates('select', arg)[0]) as HTMLSelectElement;
    const opt = [...sel.options].find(o => matches(norm(o.textContent), arg))!; fireEvent.change(sel, { target: { value: opt.value } }); await settle(0); return;
  }
  if (kind === 'select') {
    const sel = await waitStep(spec, () => candidates('select', arg)[0]) as HTMLSelectElement;
    if (isLast) { const opt = [...sel.options].find(o => matches(norm(o.textContent), arg))!; fireEvent.change(sel, { target: { value: opt.value } }); await waitStep(`${spec}: the choice took`, () => sel.value === opt.value); }
    return;
  }
  const el = await waitStep(spec, () => candidates(kind, arg)[0]);
  if (kind === 'css' && spec.includes('.cursor-col-resize')) return; // handled by the following drag step
  if (!isLast) { click(el); await settle(0); } else expect(enabled(el), `${spec} is disabled`).toBe(true);
}

const seedBefore = async (seeds: Seed[] = []) => {
  if (seeds.includes('import')) {
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    await documentRepository.importDocx(r, { title: 'First' });
    await documentRepository.importDocx(r, { title: 'Second' }); // the second import replaces the first, which leaves a restorable backup
  }
  if (seeds.includes('snapshot')) await db.versionSnapshots.add({ id: 'v1', name: 'Draft 1', timestamp: Date.now(), title: 'T', content: '<p>x</p>', wordCount: 1 });
  if (seeds.includes('saved-doc')) await documentRepository.save({ title: 'Existing', saveState: 'Saved', docJson: htmlToDoc('<h2>Intro</h2><p>Work the author already did.</p>'), format: createFormat('nih'), comments: [], citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, mode: 'manuscript', grantInstructions: '', grantTemplateId: null } as any);
  if (seeds.includes('grant')) {
    const body = Array.from({ length: 700 }, (_, i) => `word${i}`).join(' ');
    await documentRepository.save({
      title: 'Grant', saveState: 'Draft', docJson: htmlToDoc(`<h2>Specific Aims</h2><p>${body}</p>`), format: createFormat('nih'), comments: [],
      citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, mode: 'grant', grantInstructions: '', grantTemplateId: 'nih-r01',
    } as any);
  }
};

const POEM = '<h2>Intro</h2><p>Alpha beta gamma delta epsilon zeta eta theta iota kappa. Lambda mu nu xi omicron pi rho sigma tau upsilon.</p>';
const STYLE_TEXT = '<h2>Intro</h2>' + '<p>' + Array.from({ length: 14 }, (_, i) => `Moreover, it is important to note that result ${i} is robust; indeed, it underscores a pivotal role, which matters — greatly.`).join(' ') + '</p>';
const seedAfter = async (seeds: Seed[] = []) => {
  await act(async () => {
    const ed = editor(); // the text first: highlights are drawn from the suggestions against the text that is there
    if (seeds.includes('outline') || seeds.includes('text-selection') || seeds.includes('word-selection')) ed.commands.setContent(POEM);
    if (seeds.includes('cited-text')) ed.commands.setContent('<p>A claim that needs its source [1] right here.</p>');
    if (seeds.includes('style-text')) ed.commands.setContent(STYLE_TEXT);
    if (seeds.includes('table')) { ed.commands.setContent('<p>Cell text</p>'); ed.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false }); }
    if (seeds.includes('advisory')) useAIStore.setState({ suggestions: [{ id: 'adv', originalText: 'Alpha', suggestedText: '', explanation: 'Needs a citation', recommendation: 'Cite a source.', agent: 'reviewer-2', startIndex: 0, endIndex: 5, severity: 'major', kind: 'advisory' } as any] });
    if (seeds.includes('voice-profile')) {
      const { profile } = buildProfile('Mine', [Array.from({ length: 700 }, (_, i) => `I measured sample ${i} and it held, so we kept it.`).join(' ')]);
      useAIStore.setState({ aiSettings: { ...useAIStore.getState().aiSettings, voiceProfile: profile } });
    }
    if (seeds.includes('local-model')) useAIStore.setState({ aiSettings: { ...useAIStore.getState().aiSettings, provider: 'local', localModel: 'llama3' } });
    if (seeds.includes('analyzing')) useAIStore.setState({ isAnalyzing: true });
    if (seeds.includes('suggestion')) useAIStore.setState({ suggestions: [{ id: 's1', originalText: 'Alpha', suggestedText: 'Beta', explanation: 'EXPLAIN_ME', agent: 'editor', startIndex: 0, endIndex: 5, severity: 'minor' } as any] });
    if (seeds.includes('many-suggestions')) useAIStore.setState({ suggestions: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, originalText: `Quoted ${i}`, suggestedText: `Better ${i}`, explanation: `Why ${i}`, agent: 'editor', startIndex: i, endIndex: i + 5, severity: 'minor' })) as any });
    if (seeds.includes('chat-suggestions')) useAIStore.setState({ messages: [{ id: 'm-cards', role: 'assistant', content: 'Here are two proposals.', agent: 'editor', suggestions: [
      { id: 'c1', originalText: 'Alpha', suggestedText: 'Beta', explanation: 'Card change', agent: 'editor', startIndex: 0, endIndex: 5, severity: 'minor' },
      { id: 'c2', originalText: 'Lambda', suggestedText: '', explanation: 'Card advisory', recommendation: 'Cite it.', agent: 'reviewer-2', startIndex: 0, endIndex: 6, severity: 'major', kind: 'advisory' },
    ] }] as any });
    if (seeds.includes('history')) useAIStore.setState({ history: [{ id: 'h1', timestamp: 1, oldContent: '<p>a</p>', newContent: '<p>b</p>', originalText: 'Alpha', suggestedText: 'beta gamma', suggestionId: 's1', agent: 'editor' }] });
    if (seeds.includes('sources')) useSourceStore.setState({ sources: [
      { id: 'p1', name: 'paper.pdf', type: 'pdf', text: 'Body text of the paper', digest: 'dig', abstractText: 'abs' },
      { id: 'a1', name: 'API one', type: 'api', text: 'x', digest: 'dig2', apiMeta: { title: 'T', authors: 'A B', journal: 'J', doi: '10.1/x', abstract: 'abs', year: 2020, score: 1, source: 'PubMed' } },
      { id: 'b1', name: 'refs.bib', type: 'bib', text: '@article{k, title={T}, author={A}, year={2020}, journal={J}}' },
    ] });
    if (seeds.includes('citations')) useDocumentStore.setState({ citationRegistry: { a1: 1 }, citationCounter: 1 });
    if (seeds.includes('text-selection')) ed.commands.setTextSelection({ from: 8, to: 60 });
    if (seeds.includes('word-selection')) ed.commands.setTextSelection({ from: 8, to: 13 });
    if (seeds.includes('figure')) {
      ed.chain().insertContent({ type: 'resizableImage', attrs: { src: 'data:image/png;base64,AAAA' } }).run();
      let pos = -1; ed.state.doc.descendants((n: any, p: number) => { if (n.type.name === 'resizableImage') pos = p; });
      ed.commands.setNodeSelection(pos);
    }
  });
  if (seeds.some(s => s === 'text-selection' || s === 'word-selection' || s === 'figure')) await settle(250);
};

async function resetWorld() {
  cleanup();
  await flushPersist(); // a persist still in flight from the last row must land before the tables are cleared
  localStorage.clear();
  useAIStore.setState(useAIStore.getInitialState(), true);
  useSourceStore.setState(useSourceStore.getInitialState(), true);
  useDocumentStore.setState(useDocumentStore.getInitialState(), true);
  await Promise.all(db.tables.map(t => t.clear()));
}

/** Mounts the real App on a clean database and walks the steps; throws naming the first step that cannot be taken. */
export async function resolve(steps: string[], seed: Seed[] = []): Promise<true> {
  await resetWorld();
  await seedBefore(seed);
  render(<App />);
  await waitStep('the app mounts', () => editor() && screen.queryAllByRole('button').some(b => (b.getAttribute('aria-label') ?? '').startsWith('Write —')));
  await seedAfter(seed);
  for (let i = 0; i < steps.length; i++) await step(steps[i], i === steps.length - 1);
  return true;
}

// ── The contract ────────────────────────────────────────────────────────────────────────────────────────────────────────
const source = (p: string) => readFileSync(p, 'utf8');
const stepsOf = (e: EntryPoint) => [...e.path, ...(e.now ?? [])];
/** Titles and button labels that name no feature: static notices, readouts, the other state of a toggle, or a part of a control a row already covers. */
const NOT_A_FEATURE: Record<string, string> = {
  'Manuscript mode — journal-style agents': 'the other half of the mode toggle (row: switch between manuscript and grant mode)',
  'Remove image': 'chip on an attached chat image (rows: drop/paste an image into chat)',
  'Copy to My Templates for editing': 'inside the template picker, which moves whole (row: pick a grant template)',
  'Page limit (blank = none)': 'inside the template picker, which moves whole',
  'Saved ': 'tooltip on the Restore previous document item (row: restore the previous document)',
  'Over the ': 'tooltip on Trim (row: trim an over-budget section)',
  'Query: ': 'tooltip on a literature-search source card',
  'Funder instructions active — all agents follow them': 'the other state of the instructions toggle (row: edit grant instructions)',
};
/** Template titles that start with an expression, so there is no prefix to match; each is covered by the rows named. */
const TEMPLATE_TITLES: Record<string, string> = {
  '${ts.title}: ${words}': 'tooltip on a grant budget chip (row: see grant section page budgets)',
  '${src.name}': 'tooltip on an attached source (row: choose which sources the chat sees)',
};
/** Buttons whose only label is an icon (no title, no text): the guard cannot name them, so it counts them. A new one fails until a row covers it (an `icon:` step) and this count moves. */
const ICON_ONLY_BUTTONS: Record<string, number> = {
  // App 0: the left icon rail, the Download menu, Settings, the analyze chevron and the toast action all left App.tsx (the menus are TopBar's; the toast is AppOverlays').
  'src/App.tsx': 0,
  // Editor 0: the mobile toolbar toggle, the bubble's marks, synonym chips and instruction send left with the toolbar (SelectionBar, aiPanels); the table menu items, the @-picker
  // sources and the figure-question send moved to their own files below.
  'src/components/Editor.tsx': 0,
  // Sidebar 3: the inline chat suggestion cards' accept/reject, agent chips, vision X, send. (Task 7 removed the Sources/Style tab strip with the Style tab.)
  // (Task 4 moved the severity filter and the suggestion cards' own buttons to the Review panel, which names its controls with test ids.
  // Task 5 moved clear-reference-search, trash, source tabs and PDF tabs to the Cite panel, which names every one with a test id.)
  'src/components/Sidebar.tsx': 3,
  'src/components/style/StylePanel.tsx': 1, // jump to a flagged sentence
  'src/components/style/VoiceProfileManager.tsx': 0,
  'src/components/panels/ReviewPanel.tsx': 4, // section toggles (rows: read the style comparison / open chat), severity chips, row action buttons, named-agent items
  'src/components/panels/SuggestionBody.tsx': 0, 'src/components/panels/suggestionParts.tsx': 0,
  'src/components/panels/CitePanel.tsx': 1, // section toggles (rows: every section: step)
  'src/components/panels/cite/ReferenceManager.tsx': 1, // clear the reference search (row: clear the reference search)
  'src/components/panels/cite/SourceCard.tsx': 1, // trash (row: remove a source)
  'src/components/panels/cite/SourceTabs.tsx': 2, // the Summary/Abstract switch on a search-result card and on a document card (rows: switch a PDF between summary and abstract)
  'src/components/panels/cite/Library.tsx': 0, 'src/components/panels/cite/PdfMatch.tsx': 0, 'src/components/panels/cite/Search.tsx': 0,
  'src/components/panels/WritePanel.tsx': 1, // section toggles (rows: every section: step)
  'src/components/panels/write/Outline.tsx': 0, 'src/components/panels/write/History.tsx': 0, 'src/components/panels/write/Versions.tsx': 0,
  'src/components/panels/FormatPanel.tsx': 1, // section toggles (rows: every section: step); the mode buttons carry titles
  'src/components/panels/format/PageSection.tsx': 0, 'src/components/panels/format/StylesSection.tsx': 0, 'src/components/panels/format/NumField.tsx': 0,
  // Task 8. TopBar 0: the menu triggers carry an aria-label or visible words, every menu item a title. The rest, each reached by a row:
  'src/components/shell/TopBar.tsx': 0, 'src/components/shell/useTopBarItems.tsx': 0,
  'src/components/shell/aiPanels.tsx': 1, // the synonym chips (rows: replace a word with a synonym)
  'src/components/shell/AppOverlays.tsx': 1, // the toast's action button, labelled by whoever raised the toast (row: use the restore button on the import message)
  'src/components/editor/SelectionBar.tsx': 0, 'src/components/editor/FigureControls.tsx': 0,
  'src/components/editor/TableMenus.tsx': 1, // the table context-menu items (rows: add/delete a table row/column, delete a table)
  'src/components/editor/CitationPicker.tsx': 1, // a source in the @ picker (row: choose a source in the @ picker)
};

/** The body of the `{...}` that opens at `i` (balanced), or null. */
const balanced = (src: string, i: number): string | null => {
  let d = 0;
  for (let j = i; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(i + 1, j); }
  return null;
};
/** The test ids a tag can carry: `data-testid="x"`, or every string in `data-testid={cond ? 'a' : 'b'}`. */
const testidsIn = (tag: string): string[] => {
  const out: string[] = [];
  for (const m of tag.matchAll(/data-testid=(?:"([^"]+)"|\{)/g)) {
    if (m[1]) out.push(m[1]); else out.push(...literals((balanced(tag, m.index! + m[0].length - 1) ?? '').replace(/[=!]==?\s*(['"`])[^'"`]*\1/g, '')));
  }
  return out;
};
/** The opening tag that contains offset `at`. */
const tagAt = (src: string, at: number): string => {
  const open = src.lastIndexOf('<', at);
  let d = 0, j = at;
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') d++; else if (c === '}') d--; else if (c === '>' && d === 0) break; }
  return src.slice(open, j);
};
/** A control carrying a test id is reached by a row whose path has the matching step: data-testid="control-x" <-> 'control:x'. */
const reachedByTestid = (ids: string[], steps: string[]) => ids.some(id => steps.includes(id.replace('-', ':')));
const literals = (expr: string) => [...expr.matchAll(/'((?:\\'|[^'\n])*)'|"((?:\\"|[^"\n])*)"|`((?:\\`|[^`])*)`/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '').filter(Boolean);
/** Every title the source can produce: `title="x"`, and each string in `title={ternary ? 'a' : 'b'}` or a template, as an exact title or a prefix before the first ${...}. */
export function titlesIn(src: string): { raw: string; prefix: string | null; exact: string | null; testids: string[] }[] {
  const out: { raw: string; prefix: string | null; exact: string | null; testids: string[] }[] = [];
  for (const m of src.matchAll(/\btitle="([^"]+)"/g)) out.push({ raw: m[1], prefix: null, exact: m[1], testids: testidsIn(tagAt(src, m.index!)) });
  for (const m of src.matchAll(/\btitle=\{/g)) {
    const expr = balanced(src, m.index! + m[0].length - 1) ?? '';
    const testids = testidsIn(tagAt(src, m.index!));
    for (const lit of literals(expr.replace(/[=!]==?\s*(['"`])[^'"`]*\1/g, ''))) out.push(lit.includes('${') ? { raw: lit, prefix: lit.slice(0, lit.indexOf('${')), exact: null, testids } : { raw: lit, prefix: null, exact: lit, testids });
  }
  return out;
}
/** Each <button> with no title/aria-label: its visible words (static text and the strings inside {...}). */
export function textOnlyButtons(src: string): { words: string[]; line: number; testids: string[] }[] {
  const out: { words: string[]; line: number; testids: string[] }[] = [];
  for (const m of src.matchAll(/<button\b/g)) {
    let j = m.index! + 7, d = 0;
    for (; j < src.length; j++) { const c = src[j]; if (c === '{') d++; else if (c === '}') d--; else if (c === '>' && d === 0) break; }
    const open = src.slice(m.index!, j);
    if (/\btitle=|aria-label=/.test(open) || open.endsWith('/')) continue;
    const close = src.indexOf('</button>', j);
    const body = src.slice(j + 1, close);
    const words: string[] = [];
    for (let k = 0; k < body.length; ) {
      if (body[k] === '{') { const e = balanced(body, k) ?? ''; if (!/^\s*\/\*/.test(e)) words.push(...literals(e)); k += e.length + 2; }
      else if (body[k] === '<') { let dd = 0; k++; for (; k < body.length; k++) { if (body[k] === '{') dd++; else if (body[k] === '}') dd--; else if (body[k] === '>' && dd === 0) break; } k++; }
      else { let e = k; while (e < body.length && body[e] !== '{' && body[e] !== '<') e++; const t = norm(body.slice(k, e)); if (t) words.push(t); k = e; }
    }
    out.push({ words: words.filter(w => /^[A-Z][A-Za-z0-9 &?!.…,'—()-]*$/.test(w)), line: src.slice(0, m.index!).split('\n').length, testids: testidsIn(open) });
  }
  return out;
}
/**
 * Test ids that deliberately appear on more than one control in the guarded files (e.g. a per-row control extracted into its own file).
 * Each entry MUST carry a reason: an entry without one is a defect and fails the test below. Sharing is allowed, never silent.
 */
const SHARED_TESTIDS: Record<string, string> = {
  'control-regenerate-summary': 'the same Regenerate button on a search-result card (ApiSourceDetails) and on a PDF/text/BibTeX card (DocumentSourceTabs); one row proves the action, both cards render it',
  'control-source-tabs': 'the Summary/Abstract switch on a search-result card and on a PDF/text/BibTeX card; one row proves the switch, both cards render it',
  'control-compare-source': 'the Compare button on a search-result card and on a PDF/text card; one row proves it, both render it',
};
const GUARDED = ['src/App.tsx', 'src/components/Editor.tsx', 'src/components/Sidebar.tsx', 'src/components/style/StylePanel.tsx', 'src/components/style/VoiceProfileManager.tsx',
  'src/components/panels/ReviewPanel.tsx', 'src/components/panels/SuggestionBody.tsx', 'src/components/panels/suggestionParts.tsx',
  'src/components/panels/CitePanel.tsx', 'src/components/panels/cite/Library.tsx', 'src/components/panels/cite/SourceCard.tsx', 'src/components/panels/cite/PdfMatch.tsx',
  'src/components/panels/cite/SourceTabs.tsx', 'src/components/panels/cite/Search.tsx', 'src/components/panels/cite/ReferenceManager.tsx',
  'src/components/panels/WritePanel.tsx', 'src/components/panels/write/Outline.tsx', 'src/components/panels/write/History.tsx', 'src/components/panels/write/Versions.tsx',
  'src/components/panels/FormatPanel.tsx', 'src/components/panels/format/PageSection.tsx', 'src/components/panels/format/StylesSection.tsx', 'src/components/panels/format/NumField.tsx',
  // Task 8: the top bar, its menus' panels and the overlays that left App.tsx; the selection bar, the figure controls and the editor's pickers that left Editor.tsx.
  'src/components/shell/TopBar.tsx', 'src/components/shell/aiPanels.tsx', 'src/components/shell/AppOverlays.tsx', 'src/components/shell/useTopBarItems.tsx',
  'src/components/editor/SelectionBar.tsx', 'src/components/editor/FigureControls.tsx', 'src/components/editor/TableMenus.tsx', 'src/components/editor/CitationPicker.tsx'];

describe('the list itself', () => {
  it('covers every rail task', () => {
    const tasks = new Set<RailTask>();
    for (const e of ENTRY_POINTS) for (const p of [e.path[0], e.now?.[0]]) if (p?.startsWith('rail:')) tasks.add(p.slice(5) as RailTask);
    expect([...tasks].sort()).toEqual(['cite', 'format', 'review', 'write']);
  });
  it('names a unique feature per row', () => {
    const names = ENTRY_POINTS.map(e => e.feature);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
  it('a pending row names its task and its current home (or is new); a settled row has no "now"', () => {
    for (const e of ENTRY_POINTS) {
      if (e.pending) { expect(e.pending, e.feature).toBeGreaterThanOrEqual(4); expect(!!e.now || !!e.isNew, `${e.feature} needs a current home or isNew`).toBe(true); }
      else expect(e.now, `${e.feature} resolves its path now, so it needs no "now"`).toBeUndefined();
    }
  });
  it('every sidebar tab has a row', () => {
    const steps = ENTRY_POINTS.flatMap(stepsOf);
    const tabs = new Set([...source('src/components/Sidebar.tsx').matchAll(/activeTab === '([a-z]+)'/g)].map(m => m[1]).filter(t => t !== 'summary'));
    expect([...tabs].sort()).toEqual(['chat', 'history', 'outline', 'sources', 'style', 'suggestions']);
    // chat and suggestions are no longer tabs: the Review panel folds them in (the chat as a collapsible section, the suggestions as rows)
    for (const t of ['chat', 'history', 'outline', 'style']) expect(steps, `tab "${t}" has no row`).toContain(`section:${t}`);
    expect(steps, 'the suggestions have no row').toContain('row:suggestion');
    expect(steps, 'the sources tab has no row').toContain('rail:cite');
  });
  it('every title the surfaces can produce (literal, ternary or template) has a row or a reason', () => {
    const allSteps = ENTRY_POINTS.flatMap(stepsOf);
    const titleSteps = allSteps.filter(st => st.startsWith('title:')).map(st => st.slice(6));
    const uncovered: string[] = [];
    for (const f of [...GUARDED, 'src/components/GrantPanel.tsx', 'src/components/VersionHistoryPopup.tsx']) {
      for (const t of titlesIn(source(f))) {
        if (t.raw.startsWith('Editor width')) continue; // editorWidth is EXCLUDED
        if (t.exact !== null && t.exact in NOT_A_FEATURE) continue;
        if (t.prefix !== null && (t.prefix in NOT_A_FEATURE || t.raw.slice(0, 24) in TEMPLATE_TITLES || Object.keys(TEMPLATE_TITLES).some(k => t.raw.startsWith(k.slice(0, 20))))) continue;
        const ok = reachedByTestid(t.testids, allSteps) || (t.exact !== null ? titleSteps.some(v => matches(t.exact!, v)) : t.prefix !== '' && titleSteps.some(v => v.replace(/\*$/, '').startsWith(t.prefix!)));
        if (!ok) uncovered.push(`${f}: "${t.raw}"`);
      }
    }
    expect(uncovered, 'controls with a title and no row').toEqual([]);
  });
  it('every button that is only text has a row whose step reaches that button', () => {
    // Each text-only <button> in App, Editor, Sidebar and the style panel is matched, strictly (exact, or the step's own * wildcards), against the text steps whose SCOPE
    // can contain it: panel files take ptext:/select:, Editor takes text:/ctext:, App takes text:/htext:/stext:/mtext:. A "Dismiss" in the Editor is therefore not
    // satisfied by the Sidebar's `ptext:Dismiss`. Does NOT see: buttons built by a helper component (ToolbarButton is title-guarded), modal contents beyond the gate
    // rows (Settings, the grant pickers, Post-Drafting, import report, version history), or an icon-only button with no title (counted below).
    const KINDS: Record<string, string[]> = {
      'src/App.tsx': ['text', 'htext', 'stext', 'mtext'], 'src/components/Editor.tsx': ['text', 'ctext'],
      'src/components/Sidebar.tsx': ['ptext', 'select'], 'src/components/style/StylePanel.tsx': ['ptext'], 'src/components/style/VoiceProfileManager.tsx': ['ptext'],
      'src/components/panels/ReviewPanel.tsx': ['ptext'], 'src/components/panels/SuggestionBody.tsx': ['ptext'], 'src/components/panels/suggestionParts.tsx': ['ptext'],
      'src/components/panels/CitePanel.tsx': ['ptext'], 'src/components/panels/cite/Library.tsx': ['ptext'], 'src/components/panels/cite/SourceCard.tsx': ['ptext'],
      'src/components/panels/cite/PdfMatch.tsx': ['ptext'], 'src/components/panels/cite/SourceTabs.tsx': ['ptext'], 'src/components/panels/cite/Search.tsx': ['ptext'],
      'src/components/panels/cite/ReferenceManager.tsx': ['ptext', 'select'],
      'src/components/panels/WritePanel.tsx': ['ptext'], 'src/components/panels/write/Outline.tsx': ['ptext'], 'src/components/panels/write/History.tsx': ['ptext'], 'src/components/panels/write/Versions.tsx': ['ptext'],
      'src/components/panels/FormatPanel.tsx': ['ptext'], 'src/components/panels/format/PageSection.tsx': ['ptext'], 'src/components/panels/format/StylesSection.tsx': ['ptext'], 'src/components/panels/format/NumField.tsx': ['ptext'],
      'src/components/shell/TopBar.tsx': ['htext'], 'src/components/shell/aiPanels.tsx': ['htext'], 'src/components/shell/AppOverlays.tsx': ['text', 'mtext'], 'src/components/shell/useTopBarItems.tsx': ['htext'],
      'src/components/editor/SelectionBar.tsx': ['htext'], 'src/components/editor/FigureControls.tsx': ['text', 'ctext'], 'src/components/editor/TableMenus.tsx': ['text', 'ctext'], 'src/components/editor/CitationPicker.tsx': ['text', 'ctext'],
    };
    const steps = ENTRY_POINTS.flatMap(stepsOf).map(st => ({ kind: st.slice(0, st.indexOf(':')), v: st.slice(st.indexOf(':') + 1).replace(/#\d+$/, '') }));
    const uncovered: string[] = [];
    for (const f of GUARDED) {
      for (const b of textOnlyButtons(source(f))) {
        if (b.words.length === 0) continue;
        const named = reachedByTestid(b.testids, ENTRY_POINTS.flatMap(stepsOf)) || b.words.some(w => w in NOT_A_FEATURE || steps.some(st => KINDS[f].includes(st.kind) && matches(w, st.v)));
        if (!named) uncovered.push(`${f}:${b.line}: ${b.words.join(' | ')}`);
      }
    }
    expect(uncovered, 'text buttons with no row that reaches them').toEqual([]);
  });
  it('icon-only buttons (no title, no text) are counted: a new one must get a row with an icon: step', () => {
    const counts = Object.fromEntries(GUARDED.map(f => [f, textOnlyButtons(source(f)).filter(b => b.words.length === 0).length]));
    expect(counts).toEqual(ICON_ONLY_BUTTONS);
  });
  it('every top-bar menu item has a row that reaches it (a menu item cannot be dropped silently)', () => {
    const steps = ENTRY_POINTS.flatMap(stepsOf);
    const src = source('src/components/shell/useTopBarItems.tsx');
    // ids written out in the menus: `{ id: 'new', ...}`; an item with its own testId is reached by that; the six presets are generated from SELECTION_PRESETS.
    const ids = new Set<string>();
    for (const m of src.matchAll(/\{\s*id: '([a-z-]+)'(?:,\s*testId: '([a-z-]+)')?/g)) ids.add(m[2] ?? m[1]);
    for (const m of src.matchAll(/testId: '([a-z-]+)'/g)) ids.add(m[1]);
    for (const l of ['Polish', 'Shorten', 'Sharpen', 'Strengthen', 'Critique', 'Explain']) ids.add(l.toLowerCase());
    expect(ids.size, 'the menu definitions were not found').toBeGreaterThan(25);
    const unreached = [...ids].filter(id => !steps.includes(`item:${id}`));
    expect(unreached, 'menu items with no row').toEqual([]);
    // and the generated presets really are the six this list names
    expect(source('src/components/shell/selectionPresets.ts').match(/label: '([A-Za-z]+)'/g)!.map(x => x.slice(8, -1))).toEqual(['Polish', 'Shorten', 'Sharpen', 'Strengthen', 'Critique', 'Explain']);
  });
  it('a test id belongs to one control across the guarded files, so a step cannot vouch for a different button that reuses its name', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const f of GUARDED) {
      const src = source(f);
      for (const m of src.matchAll(/data-testid=/g)) for (const id of testidsIn(tagAt(src, m.index!))) {
        if (id.includes('$') || id in SHARED_TESTIDS) continue;
        const prev = seen.get(id);
        if (prev !== undefined && prev !== `${f}:${tagAt(src, m.index!)}`) dupes.push(`${id} (${prev.split(':')[0]} and ${f})`);
        seen.set(id, `${f}:${tagAt(src, m.index!)}`);
      }
    }
    expect(dupes).toEqual([]);
  });
  it('every shared test id states why it is shared, and is still shared', () => {
    for (const [id, reason] of Object.entries(SHARED_TESTIDS)) {
      expect(reason.trim().length, `SHARED_TESTIDS["${id}"] has no reason: an entry without one is a defect`).toBeGreaterThan(10);
      const files = GUARDED.filter(f => source(f).includes(`"${id}"`) || source(f).includes(`'${id}'`));
      expect(files.length, `SHARED_TESTIDS["${id}"} is not used by any guarded file any more; delete the entry`).toBeGreaterThan(0);
    }
  });
  it('every EXCLUDED entry is a deliberate removal with a reason', () => {
    expect(EXCLUDED.map(x => x.feature)).toEqual(['editorWidth (normal/wide/full)', 'second version-history component (VersionHistoryPanel)']);
    for (const x of EXCLUDED) expect(x.reason.length).toBeGreaterThan(10);
  });
});

describe('the resolver is honest about what a user can reach', () => {
  const mk = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); return d; };
  afterEach(() => { document.body.innerHTML = ''; });
  it.each([
    ['a hidden attribute', '<aside hidden><button id="t">x</button></aside>'],
    ['aria-hidden', '<div aria-hidden="true"><button id="t">x</button></div>'],
    ['inline display none', '<div style="display:none"><button id="t">x</button></div>'],
    ['inline visibility hidden', '<div style="visibility:hidden"><button id="t">x</button></div>'],
    ['a Tailwind hidden with no reveal', '<div class="hidden"><button id="t">x</button></div>'],
    ['invisible', '<div class="invisible"><button id="t">x</button></div>'],
    ['sr-only', '<div class="sr-only"><button id="t">x</button></div>'],
    ['opacity-0', '<div class="opacity-0"><button id="t">x</button></div>'],
    ['inline opacity 0', '<div style="opacity:0"><button id="t">x</button></div>'],
    ['pointer-events-none', '<div class="pointer-events-none"><button id="t">x</button></div>'],
    ['inline pointer-events none', '<div style="pointer-events:none"><button id="t">x</button></div>'],
    ['w-0', '<div class="w-0"><button id="t">x</button></div>'],
    ['max-h-0 with overflow-hidden', '<div class="max-h-0 overflow-hidden"><button id="t">x</button></div>'],
    ['sm:hidden at desktop width', '<div class="flex sm:hidden"><button id="t">x</button></div>'],
    ['a reveal only from a wider breakpoint (xl)', '<div class="hidden xl:flex"><button id="t">x</button></div>'],
  ])('a control behind %s is not reachable', (_n, html) => { mk(html); expect(isShown(document.getElementById('t')!)).toBe(false); });
  it.each([
    ['a responsive reveal', '<div class="hidden sm:flex"><button id="t">x</button></div>'],
    ['a hover menu', '<div class="hidden group-hover:block"><button id="t">x</button></div>'],
    ['a hover-revealed opacity-0', '<div class="opacity-0 hover:opacity-50"><button id="t">x</button></div>'],
    ['a group-hover-revealed invisible', '<div class="invisible group-hover:visible"><button id="t">x</button></div>'],
    ['a group-hover-revealed pointer-events-none', '<div class="pointer-events-none group-hover:pointer-events-auto"><button id="t">x</button></div>'],
    ['a breakpoint reveal that applies at desktop width (lg)', '<div class="hidden lg:flex"><button id="t">x</button></div>'],
    ['max-h-0 without overflow-hidden', '<div class="max-h-0"><button id="t">x</button></div>'],
  ])('a control behind %s is reachable', (_n, html) => { mk(html); expect(isShown(document.getElementById('t')!)).toBe(true); });
});

describe('reachability: resolves in the mounted App now', () => {
  it.each(ENTRY_POINTS.filter(e => !e.pending))('$feature', async (e) => { await expect(resolve(e.path, e.seed)).resolves.toBe(true); }, 30000);
});

describe('reachability: still reachable at its current home until its task moves it', () => {
  const waiting = ENTRY_POINTS.filter(e => e.pending && e.now);
  if (waiting.length) it.each(waiting)('$feature (Task $pending)', async (e) => { await expect(resolve(e.now!, e.seed)).resolves.toBe(true); }, 30000);
  else it('no row is waiting on a later task: every feature has reached its new home', () => { expect(ENTRY_POINTS.filter(e => e.pending)).toEqual([]); });
});

// ── App wiring, observed rather than read ───────────────────────────────────────────────────────────────────────────────
// These replace three source-text regexes on App.tsx that shellLogic.test.tsx used in Task 2.
const railBtn = (name: string) => screen.getAllByRole('button').find(b => (b.getAttribute('aria-label') ?? '').startsWith(`${name} —`))!;
const panel = () => document.querySelector('aside.u-shell-panel') as HTMLElement;
const mount = async () => { await resetWorld(); render(<App />); await waitStep('mounts', () => editor() && railBtn('Write')); };

describe('App wiring (behaviour)', () => {
  it('the document format reaches the page the Editor draws and the estimate the status bar shows', async () => {
    const pagesFor = async (margin: number, size: 'letter' | 'a4') => {
      await resetWorld();
      const format = createFormat('nih');
      format.page = { size, orientation: 'portrait', marginsIn: { top: margin, right: margin, bottom: margin, left: margin } };
      const body = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' ');
      await documentRepository.save({ title: 'T', saveState: 'Draft', docJson: htmlToDoc(`<p>${body}</p>`), format, comments: [], citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, mode: 'manuscript', grantInstructions: '', grantTemplateId: null } as any);
      cleanup();
      render(<App />);
      const canvas = await waitStep('the page canvas', () => screen.queryByTestId('page-canvas')) as HTMLElement;
      await waitFor(() => expect(canvas.style.paddingLeft).toBe(`${margin}in`), { timeout: 4000 });
      await waitStep('the whole text is in the status bar', () => [...document.querySelectorAll('[role=status] span')].some(x => norm(x.textContent) === '1,500 words'));
      await settle(300); // the estimate follows the document by a deferred render
      const pages = await waitStep('page estimate', () => [...document.querySelectorAll('[role=status] span')].map(x => norm(x.textContent)).find(t => /^~?\d+ pp$/.test(t)));
      return { width: canvas.style.width, pad: canvas.style.paddingLeft, pages: Number(pages.replace(/\D/g, '')) };
    };
    const narrow = await pagesFor(0.5, 'letter'), wide = await pagesFor(2, 'a4');
    expect(narrow).toMatchObject({ width: '8.5in', pad: '0.5in' });
    expect(wide).toMatchObject({ width: '8.27in', pad: '2in' });
    expect(wide.pages, 'wider margins must give more pages from the same text').toBeGreaterThan(narrow.pages);
  }, 40000);

  it('a margin typed in the Format panel moves the page canvas, and a page limit typed there reaches the status bar', async () => {
    await mount();
    fireEvent.click(railBtn('Format'));
    const canvas = await waitStep('the page canvas', () => screen.queryByTestId('page-canvas')) as HTMLElement;
    const left = await waitStep('the left margin', () => screen.queryByTestId('control-margin-left')) as HTMLInputElement;
    expect(canvas.style.paddingLeft).toBe('0.5in');
    fireEvent.change(left, { target: { value: '1.5' } });
    await waitFor(() => expect(canvas.style.paddingLeft).toBe('1.5in'));
    fireEvent.change(left, { target: { value: '-1' } }); // rejected: the page keeps the last good margin
    await settle(50);
    expect(canvas.style.paddingLeft).toBe('1.5in');
    const status = () => [...document.querySelectorAll('[role=status] span')].map(x => norm(x.textContent));
    expect(status().some(t => /^~?\d+ pp$/.test(t))).toBe(true); // no limit set: the estimate alone
    fireEvent.change(screen.getByTestId('control-page-limit'), { target: { value: '13' } });
    await waitFor(() => expect(status().some(t => /^~?\d+ of 13$/.test(t))).toBe(true));
    fireEvent.change(screen.getByTestId('control-page-limit'), { target: { value: '' } });
    await waitFor(() => expect(status().some(t => /^~?\d+ pp$/.test(t))).toBe(true));
  }, 20000);

  it('the rail decides what is open; closing it stays closed and a tab change moves both together', async () => {
    await mount();
    const open = (n: string) => railBtn(n).getAttribute('aria-pressed') === 'true';
    fireEvent.click(railBtn('Format'));
    expect(open('Format')).toBe(true);
    await waitStep('format opens the Format panel', () => screen.queryByTestId('control-margin-left'));
    fireEvent.click(railBtn('Format')); // the active task again closes the panel
    expect(open('Format')).toBe(false);
    expect(panel().hasAttribute('hidden')).toBe(true);
    await settle(200); // a tab-to-rail effect would reopen it here
    expect(open('Format') || open('Write') || open('Cite') || open('Review')).toBe(false);
    expect(panel().hasAttribute('hidden')).toBe(true);
    fireEvent.click(railBtn('Cite')); // reopening from closed opens that task on its own tab
    expect(open('Cite')).toBe(true);
    await waitStep('cite opens Sources', () => screen.queryByText('Browse files'));
    await act(async () => { useSourceStore.setState({ sources: [{ id: 'p1', name: 'paper.pdf', type: 'pdf', text: 'Body', digest: 'dig' } as any] }); });
    fireEvent.click(await waitStep('a source card to chat about', () => screen.queryByTestId('control-chat-source'))); // a legacy tab change (the chat button on a source) moves the rail with it
    expect(open('Review')).toBe(true);
    expect(open('Cite')).toBe(false);
  });

  it('closing the panel keeps what was typed in it', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('section-chat')); // the chat is folded into the Review panel, collapsed until asked for
    const box = () => [...panel().querySelectorAll('textarea')].find(t => isShown(t)) as HTMLTextAreaElement;
    expect(railBtn('Review').getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(box(), { target: { value: 'half-written question' } });
    const before = panel().querySelector('textarea');
    fireEvent.click(railBtn('Review')); // close
    expect(panel().hasAttribute('hidden')).toBe(true);
    expect(screen.queryAllByTestId('section-chat').filter(isShown)).toHaveLength(0); // closed means unreachable
    fireEvent.click(railBtn('Review')); // reopen
    expect(panel().hasAttribute('hidden')).toBe(false);
    expect(box().value).toBe('half-written question');
    expect(panel().querySelector('textarea')).toBe(before); // the same element: it was hidden, not remounted
  });
});

// ── An editor unmounted while a scroll or insert is pending must not throw (a real bug these rows exposed: Editor's setTimeout callbacks used a destroyed view) ──
describe('Review panel (behaviour)', () => {
  const rowsOf = (kind: string) => screen.queryAllByTestId(`row-${kind}`).filter(isShown);
  const flaggedSentence = 'Moreover, it is important to note that this result is robust; indeed, it underscores a pivotal role, which matters — greatly.';
  const many = (n: number) => Array.from({ length: n }, (_, i) => `${flaggedSentence.replace('this', `result ${i}`)}`).join(' ');

  it('a suggestion whose text has gone can be dismissed but not applied', async () => {
    await resolve([R, 'row:suggestion'], ['suggestion', 'outline']);
    const accept = () => screen.getByTestId('control-accept') as HTMLButtonElement;
    expect(accept().disabled).toBe(false);
    await act(async () => { editor().commands.setContent('<p>Something else entirely, with no trace of the quoted word.</p>'); });
    await waitFor(() => expect(accept().disabled).toBe(true), { timeout: 4000 });
    expect((screen.getByTestId('control-reject') as HTMLButtonElement).disabled).toBe(false);
    expect(norm(screen.getByTestId('row-suggestion').textContent)).toContain('has changed');
  }, 20000);

  it('accepting a suggestion inside a flagged sentence leaves no style row able to rewrite the old span', async () => {
    await resolve([R], ['style-text']);
    await waitStep('style rows', () => rowsOf('style')[0]);
    const first = flaggedSentence.replace('this', 'result 0');
    await act(async () => { useAIStore.setState({ suggestions: [{ id: 'inside', originalText: first.slice(0, 40), suggestedText: 'Changed opening', explanation: 'x', agent: 'editor', startIndex: 0, endIndex: 40, severity: 'minor' } as any] }); });
    const accept = await waitStep('the suggestion row', () => screen.queryByTestId('control-accept')) as HTMLButtonElement;
    fireEvent.click(accept);
    // the document just changed under the audit: until it is re-measured no style row may act on its old offsets
    expect(screen.queryAllByTestId('control-rewrite').length, 'the style rows are still listed (disabled), not silently gone').toBeGreaterThan(0);
    for (const b of screen.queryAllByTestId('control-rewrite')) expect((b as HTMLButtonElement).disabled, 'a style row would rewrite a stale span').toBe(true);
  }, 20000);

  it('flagged sentences inside a table cell and a list item are listed and can be rewritten', async () => {
    await resolve([R], []);
    await act(async () => { editor().commands.setContent(`<ul><li><p>${many(1)}</p></li></ul><table><tbody><tr><td><p>${many(1).replace('result 0', 'cell')}</p></td></tr></tbody></table>`); });
    await waitFor(() => expect(rowsOf('style').length).toBeGreaterThanOrEqual(2), { timeout: 6000 });
    await waitFor(() => { for (const b of screen.queryAllByTestId('control-rewrite')) expect((b as HTMLButtonElement).disabled).toBe(false); expect(screen.queryAllByTestId('control-rewrite').length).toBeGreaterThanOrEqual(2); }, { timeout: 6000 });
  }, 20000);

  it('500 suggestions: the badge is capped, the count is exact, and only a page of rows is in the DOM', async () => {
    await resolve([R], []);
    const sugs = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, originalText: `Quoted ${i}`, suggestedText: `Better ${i}`, explanation: `Why ${i}`, agent: 'editor', startIndex: i, endIndex: i + 5, severity: 'minor' }));
    const t0 = Date.now();
    await act(async () => { useAIStore.setState({ suggestions: sugs as any }); });
    expect(screen.getByTestId('badge-review').textContent).toBe('99+');
    expect(rowsOf('suggestion').length).toBe(100);
    expect(norm(panelEl()!.textContent)).toContain('500 items');
    expect(Date.now() - t0, 'rendering 500 rows must not stall').toBeLessThan(5000);
  }, 20000);

  it('an empty document lists nothing and says so', async () => {
    await resolve([R], []);
    expect(rowsOf('suggestion').length + rowsOf('style').length).toBe(0);
    expect(norm(panelEl()!.textContent)).toMatch(/Nothing flagged/);
  });

  it('a document replaced wholesale clears the selected row', async () => {
    await resolve([R, 'markclick:'], ['suggestion', 'outline']);
    await waitStep('the highlighted row', () => document.querySelector('[data-testid="row-suggestion"].ring-2'));
    await act(async () => { useDocumentStore.setState({ importId: 'a-new-import' }); });
    expect(document.querySelector('[data-testid="row-suggestion"].ring-2')).toBeNull();
  }, 20000);
});

describe('unmounting with a pending editor timer', () => {
  const unmountWhilePending = async (setup: string[], seed: Seed[], act: string) => {
    await resolve(setup, seed);
    const [kind, ...arg] = [act.slice(0, act.indexOf(':')), act.slice(act.indexOf(':') + 1)];
    const target = await waitStep(act, () => candidates(kind, arg.join(':'))[0]); // located before the clock is faked (waitFor needs real timers)
    expect(target, act).toBeDefined();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      click(target); // schedules the 50 ms callback
      cleanup(); // the editor is destroyed before it fires
      expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    } finally { vi.useRealTimers(); }
  };
  it('after a click on an outline heading', async () => { await unmountWhilePending([W, 'section:outline'], ['outline'], 'ptext:Intro'); }, 20000);
  it('after a click on a suggestion card', async () => { await unmountWhilePending([R, 'row:suggestion'], ['suggestion', 'outline'], 'ptext:EXPLAIN_ME'); }, 20000);
  it('after jumping to a citation', async () => { await unmountWhilePending([C, 'section:references'], ['sources', 'citations', 'cited-text'], 'testid:control-goto-citation'); }, 20000);
});


// ── The top bar, observed rather than read: what the menus and the selection bar DO ───────────────────────────────────────────
describe('Top bar (behaviour)', () => {
  const menuItem = (id: string) => screen.getByTestId(`item-${id}`) as HTMLButtonElement;
  const open = async (menu: string) => { const b = await waitStep(`topbar-${menu}`, () => screen.queryByTestId(`topbar-${menu}`)); if (b.getAttribute('aria-expanded') !== 'true') click(b); };
  const docText = () => editor().state.doc.textContent;
  const AI_SELECTION_ITEMS = ['polish', 'shorten', 'sharpen', 'strengthen', 'critique', 'explain', 'rewrite', 'instruct', 'verify'];

  it('at rest the bar is the document name, three menus, the block style, version history and the overflow: eight controls or fewer', async () => {
    await resolve([], []);
    const bar = document.querySelector('.u-shell-top') as HTMLElement;
    const controls = [...bar.querySelectorAll('button, select, input')].filter(isShown);
    expect(controls.length, controls.map(c => c.getAttribute('data-testid') ?? c.getAttribute('title') ?? c.tagName).join(', ')).toBeLessThanOrEqual(8);
    for (const id of ['topbar-title', 'topbar-file', 'topbar-insert', 'topbar-ai', 'topbar-body-style', 'topbar-overflow']) expect(bar.querySelector(`[data-testid="${id}"]`), id).toBeTruthy();
    expect(bar.querySelector('[data-testid="selection-bar"]')).toBeNull();
  }, 20000);

  it('AI menu with no selection: every selection action is disabled and says to select text; the ones that do not need a selection are not', async () => {
    await resolve([], []);
    await open('ai');
    for (const id of AI_SELECTION_ITEMS) {
      expect(menuItem(id).disabled, id).toBe(true);
      expect(menuItem(id).getAttribute('title'), id).toMatch(/select/i);
    }
    for (const id of ['analyze', 'analyze-agent', 'summary', 'autocomplete']) expect(menuItem(id).disabled, id).toBe(false);
    expect(menuItem('synonyms').disabled).toBe(true);
    expect(menuItem('similar').disabled).toBe(true);
  }, 20000);

  it('the menu follows the selection: enabled while text is selected, disabled again once it collapses; word count gates synonyms and similar', async () => {
    await resolve(['topbar:ai'], ['text-selection']);
    for (const id of AI_SELECTION_ITEMS) expect(menuItem(id).disabled, id).toBe(false);
    expect(menuItem('synonyms').disabled, 'ten words is not a word to look up').toBe(true);
    expect(menuItem('similar').disabled).toBe(false);
    await act(async () => { editor().commands.setTextSelection({ from: 8, to: 13 }); });
    await waitFor(() => expect(menuItem('synonyms').disabled).toBe(false));
    expect(menuItem('similar').disabled, 'one word is not enough to search the literature').toBe(true);
    await act(async () => { editor().commands.setTextSelection(3); });
    await waitFor(() => expect(menuItem('polish').disabled).toBe(true));
  }, 20000);

  it('a preset with a selection runs on exactly the selected text', async () => {
    await resolve(['topbar:ai'], ['text-selection']);
    const selected = editor().state.doc.textBetween(editor().state.selection.from, editor().state.selection.to, ' ');
    click(menuItem('critique')); // an "analyze" preset: the answer goes to chat, starting with the quoted selection
    await waitFor(() => expect(JSON.stringify(useAIStore.getState().messages)).toContain(selected.slice(0, 40)), { timeout: 4000 });
    expect(JSON.stringify(useAIStore.getState().messages)).toContain('Identify the specific scientific weaknesses');
  }, 20000);

  it('the custom instruction goes out with the chosen agent and the typed words, and an empty box sends the stock request', async () => {
    await resolve(['topbar:ai'], ['text-selection']);
    click(menuItem('instruct'));
    fireEvent.change(screen.getByTestId('item-instruct-agent'), { target: { value: 'reviewer-2' } });
    fireEvent.change(screen.getByTestId('item-instruct-text'), { target: { value: 'tighten the second sentence' } });
    click(screen.getByTestId('item-instruct-send'));
    await waitFor(() => expect(JSON.stringify(useAIStore.getState().messages)).toContain('tighten the second sentence'), { timeout: 4000 });
    expect(screen.queryByTestId('item-instruct-send'), 'sending closes the menu').toBeNull();
    await open('ai');
    click(menuItem('instruct'));
    click(screen.getByTestId('item-instruct-send'));
    await waitFor(() => expect(JSON.stringify(useAIStore.getState().messages)).toContain('Suggest improvements for this text.'), { timeout: 4000 });
  }, 20000);

  it('Undo and Redo in the File menu act on the document, and Ctrl+Z still does too', async () => {
    await resolve([], []);
    await act(async () => { editor().commands.insertContent('typed words'); });
    expect(docText()).toContain('typed words');
    await open('file'); click(menuItem('undo'));
    await waitFor(() => expect(docText()).not.toContain('typed words'));
    await open('file'); click(menuItem('redo'));
    await waitFor(() => expect(docText()).toContain('typed words'));
    fireEvent.keyDown(editor().view.dom, { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(docText()).not.toContain('typed words'));
  }, 20000);

  it('Undo right after an import does not bring the replaced document back (a load is not an edit)', async () => {
    await resolve(['topbar:file', 'item:import', 'importdocx:body-basics.docx'], ['saved-doc']);
    await waitStep('the import message', () => screen.queryByTestId('control-toast-action'));
    await settle(500); // the import applies the document and then the stored copy of it; both are loads
    const imported = docText();
    expect(imported.length).toBeGreaterThan(10);
    expect(imported).not.toContain('Work the author already did.');
    expect(undoDepth(editor().state), 'a load must leave nothing to undo').toBe(0);
    await open('file'); click(menuItem('undo'));
    await settle(200);
    expect(docText()).toBe(imported);
    await open('file'); click(menuItem('redo'));
    await settle(200);
    expect(docText()).toBe(imported);
  }, 30000);

  it('Dark mode, Zoom and Focus mode do what they say', async () => {
    await resolve([], []);
    await open('overflow'); click(menuItem('dark-mode'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(menuItem('dark-mode').getAttribute('aria-checked')).toBe('true');
    click(menuItem('dark-mode'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    const canvas = screen.getByTestId('page-canvas') as HTMLElement;
    expect(canvas.style.zoom).toBe('1');
    click(menuItem('zoom-in'));
    await waitFor(() => expect(canvas.style.zoom).toBe('1.1'));
    expect(menuItem('zoom-in').textContent).toContain('110%');
    click(menuItem('zoom-out')); click(menuItem('zoom-out'));
    await waitFor(() => expect(canvas.style.zoom).toBe('0.9'));
    click(menuItem('focus-mode'));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Tasks' })).toBeNull());
    expect(screen.getByTestId('topbar-overflow'), 'the bar stays, so focus mode can be left').toBeTruthy();
    await open('overflow'); click(menuItem('focus-mode'));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Tasks' })).toBeTruthy());
  }, 20000);

  it('exporting waits for the acknowledgement: cancel downloads nothing, confirm downloads once', async () => {
    vi.mocked(saveAs).mockClear();
    await resolve(['topbar:file'], []);
    click(menuItem('export-md'));
    click(await waitStep('the acknowledgement', () => screen.queryByTestId('control-export-cancel')));
    expect(saveAs).not.toHaveBeenCalled();
    expect(screen.queryByTestId('control-export-confirm')).toBeNull();
    await open('file'); click(menuItem('export-md'));
    click(await waitStep('the acknowledgement', () => screen.queryByTestId('control-export-confirm')));
    await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
    expect(String(vi.mocked(saveAs).mock.calls[0][1])).toMatch(/\.md$/);
    expect(screen.queryByTestId('control-export-confirm')).toBeNull();
  }, 20000);

  it('the autocomplete switch shows its state and the editor honours it', async () => {
    await resolve(['topbar:ai'], []);
    expect(menuItem('autocomplete').getAttribute('aria-checked')).not.toBe('true');
    click(menuItem('autocomplete'));
    await waitFor(() => expect(menuItem('autocomplete').getAttribute('aria-checked')).toBe('true'));
    click(menuItem('autocomplete'));
    await waitFor(() => expect(menuItem('autocomplete').getAttribute('aria-checked')).not.toBe('true'));
  }, 20000);

  it('a synonym answer belongs to its selection: collapsing the selection removes it', async () => {
    await resolve(['topbar:ai'], ['word-selection']);
    click(menuItem('synonyms'));
    await waitStep('the synonym chip', () => screen.queryByTestId('item-synonym-choice'));
    await act(async () => { editor().commands.setTextSelection(3); });
    await waitFor(() => expect(menuItem('synonyms').disabled).toBe(true));
    expect(screen.queryByTestId('item-synonym-choice')).toBeNull();
  }, 20000);

  it('the selection bar tracks the selection: nothing, text, table, figure, and text inside a table', async () => {
    await resolve([], ['text-selection']);
    const bar = () => document.querySelector('[data-testid="selection-bar"]');
    await waitStep('the text controls', () => screen.queryByTestId('control-bold'));
    await act(async () => { editor().commands.setTextSelection(3); });
    await waitFor(() => expect(bar()).toBeNull());
    await act(async () => { editor().commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false }); });
    await waitStep('the table controls', () => screen.queryByTestId('control-row-above'));
    expect(screen.queryByTestId('control-bold')).toBeNull();
    await act(async () => { editor().commands.insertContent('inside the cell'); });
    const { from } = editor().state.selection;
    await act(async () => { editor().commands.setTextSelection({ from: from - 8, to: from }); });
    await waitStep('text controls for words inside a cell', () => screen.queryByTestId('control-bold'));
    expect(screen.queryByTestId('control-row-above')).toBeNull();
    let figAt = -1;
    await act(async () => {
      editor().chain().insertContent({ type: 'resizableImage', attrs: { src: 'data:image/png;base64,AAAA' } }).run();
      editor().state.doc.descendants((n: any, p: number) => { if (n.type.name === 'resizableImage') figAt = p; });
      editor().commands.setNodeSelection(figAt);
    });
    await waitFor(() => expect(bar()).toBeNull());
    expect(screen.queryByTestId('control-bold')).toBeNull();
  }, 30000);

  it('a figure with no caption is described with the bare prompt: no empty context block is appended', async () => {
    await resolve([], []);
    await act(async () => {
      editor().commands.setContent('<p></p>'); // nothing around the figure: no caption, no neighbouring paragraph
      editor().chain().insertContent({ type: 'resizableImage', attrs: { src: 'data:image/png;base64,AAAA' } }).run();
      let pos = -1; editor().state.doc.descendants((n: any, p: number) => { if (n.type.name === 'resizableImage') pos = p; });
      editor().commands.setNodeSelection(pos);
    });
    click(await waitStep('the figure controls', () => screen.queryByTestId('control-describe')));
    await waitFor(() => expect(useAIStore.getState().messages.some(m => m.role === 'user' && m.content === FIGURE_PROMPTS.describe)).toBe(true), { timeout: 4000 });
  }, 20000);

  it('Ctrl+S saves what is in the app NOW, not what it held when the page loaded', async () => {
    vi.mocked(saveAs).mockClear();
    await resolve([], []);
    await act(async () => { useAIStore.setState({ suggestions: [{ id: 'added-after-mount', originalText: 'Alpha', suggestedText: 'Beta', explanation: 'late', agent: 'editor', startIndex: 0, endIndex: 5, severity: 'minor' } as any] }); });
    await act(async () => { useDocumentStore.getState().setTitle('Retitled after mount'); });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1), { timeout: 4000 });
    const blob = vi.mocked(saveAs).mock.calls[0][0] as Blob;
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob); });
    expect(text).toContain('added-after-mount');
    expect(text).toContain('Retitled after mount');
  }, 20000);

  it('the figure controls show which alignment is set, and follow a change', async () => {
    await resolve(['figure:selected'], ['figure']);
    const align = () => screen.getAllByTestId('control-align-figure');
    await waitFor(() => expect(align()[1].className).toContain('bg-stone-600')); // a new figure is centred
    click(align()[2]);
    await waitFor(() => expect(align()[2].className).toContain('bg-stone-600'));
    expect(align()[1].className).not.toContain('bg-stone-600');
    expect(editor().getAttributes('resizableImage').align).toBe('right');
  }, 20000);

  it('Insert > Figure label puts a numbered label in the text and Insert > Citation types the @ that opens the picker', async () => {
    await resolve(['topbar:insert', 'item:figure-label', 'expect:node:figureLabel'], []);
    await open('insert'); click(menuItem('citation'));
    await waitStep('the picker', () => candidates('text', 'Insert Citation')[0]);
    expect(docText()).toContain('@');
    fireEvent.keyDown(editor().view.dom, { key: 'Escape' });
    await waitFor(() => expect(candidates('text', 'Insert Citation')).toHaveLength(0));
  }, 20000);
});
