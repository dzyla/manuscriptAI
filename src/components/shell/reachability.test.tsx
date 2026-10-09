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
import App from '../../App';
import { db } from '../../db/manuscriptDb';
import { useAIStore } from '../../stores/useAIStore';
import { useSourceStore } from '../../stores/useSourceStore';
import { useDocumentStore, documentRepository } from '../../stores/useDocumentStore';
import { readDocx } from '../../docx/read';
import { expose } from 'comlink';
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
export type Seed = 'cited-text' | 'saved-doc' | 'voice-profile' | 'table' | 'advisory' | 'local-model' | 'import' | 'snapshot' | 'grant' | 'suggestion' | 'history' | 'sources' | 'citations' | 'outline' | 'analyzing' | 'style-text' | 'text-selection' | 'word-selection' | 'figure' | 'many-suggestions';
export interface EntryPoint { feature: string; path: string[]; pending?: number; now?: string[]; isNew?: true; seed?: Seed[] }

const W = 'rail:write', C = 'rail:cite', R = 'rail:review', F = 'rail:format';
const row = (feature: string, path: string[], pending?: number, now?: string[], seed?: Seed[]): EntryPoint =>
  ({ feature, path, ...(pending ? { pending } : {}), ...(now ? { now } : {}), ...(seed ? { seed } : {}) });
const fresh = (feature: string, path: string[], pending: number): EntryPoint => ({ feature, path, pending, isNew: true });

export const ENTRY_POINTS: EntryPoint[] = [
  // Write
  row('see the outline', [W, 'section:outline'], undefined, undefined, ['outline']),
  row('jump to a heading from the outline', [W, 'section:outline', 'control:goto-heading'], 6, [W, 'section:outline', 'cursor:30', 'ptext:Intro', 'expect:cursor:1'], ['outline']),
  row('analyze one section from the outline', [W, 'section:outline', 'control:analyze-section'], 6, [W, 'section:outline', 'title:Analyze "Intro" section'], ['outline']),
  row('see applied-suggestion history', [W, 'section:history'], undefined, undefined, ['history']),
  row('inspect an applied change', [W, 'section:history', 'control:show-changes'], 6, [W, 'section:history', 'title:Show changes'], ['history']),
  row('revert an applied change', [W, 'section:history', 'control:revert-change'], 6, [W, 'section:history', 'title:Show changes', 'ptext:Revert Change'], ['history']),
  row('restore a version snapshot', [W, 'section:versions', 'control:restore-version'], 6, ['title:Version History', 'title:Restore'], ['snapshot']),
  row('save a version snapshot', [W, 'section:versions', 'control:save-version'], 6, ['title:Version History', 'title:Save snapshot']),
  row('preview a version snapshot', [W, 'section:versions', 'control:preview-version'], 6, ['title:Version History', 'title:Preview'], ['snapshot']),
  row('delete a version snapshot', [W, 'section:versions', 'control:delete-version'], 6, ['title:Version History', 'title:Delete'], ['snapshot']),
  // Cite
  row('upload a PDF, DOCX, BibTeX or text source', [C, 'section:library', 'control:upload'], 5, [C, 'ptext:Browse files']),
  row('add a source by DOI', [C, 'section:library', 'control:doi'], 5, [C, 'typein:10.1234/journal.article|10.1000/xyz', 'ptext:Add']),
  row('remove a source', [C, 'section:library', 'control:remove-source'], 5, [C, 'icon:trash-2'], ['sources']),
  row('regenerate a source summary', [C, 'section:library', 'control:regenerate-summary'], 5, [C, 'title:Regenerate AI summary'], ['sources']),
  row('copy a source as BibTeX', [C, 'section:library', 'control:copy-bibtex'], 5, [C, 'title:Copy BibTeX entry to clipboard'], ['sources']),
  row('compare a source with the manuscript', [C, 'section:library', 'control:compare-source'], 5, [C, 'ptext:Compare'], ['sources']),
  row('chat about one source', [C, 'section:library', 'control:chat-source'], 5, [C, 'ptext:Chat'], ['sources']),
  row('check a source against the citations', [C, 'section:library', 'control:check-citations'], 5, [C, 'ptext:Check Citations'], ['sources']),
  row('find the published record of a PDF', [C, 'section:library', 'control:match-pdf'], 5, [C, 'ph:Search paper title or keywords…'], ['sources']),
  row('search the literature', [C, 'section:search', 'control:query'], 5, [C, 'ph:Title, keywords, or paste abstract…']),
  row('format a bibliography from a BibTeX source', [C, 'section:references', 'control:format-bibliography'], 5, [C, 'ptext:Insert'], ['sources']),
  row('renumber citations', [C, 'section:references', 'control:renumber'], 5, [C, 'title:Renumber citations in document order'], ['sources', 'citations']),
  row('search the reference list', [C, 'section:references', 'control:filter-references'], 5, [C, 'ph:Search references…'], ['sources', 'citations']),
  row('jump to a citation in the document', [C, 'section:references', 'control:goto-citation'], 5, [C, 'title:Jump to citation in document'], ['sources', 'citations']),
  row('jump to the first citation of a source', [C, 'section:references', 'control:first-citation'], 5, [C, 'title:Jump to first citation'], ['sources', 'citations']),
  row('remove a citation', [C, 'section:references', 'control:remove-citation'], 5, [C, 'title:Remove citation'], ['sources', 'citations']),
  row('insert the reference list', [C, 'section:references', 'control:insert-reference-list'], 5, [C, 'ptext:Insert reference list'], ['sources', 'citations']),
  row('insert a citation with @', ['topbar:insert', 'item:citation'], 8, ['key:@', 'text:Insert Citation']),
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
  row('run an analysis', [R, 'control:analyze']),
  row('stop a running analysis', [R, 'control:stop'], undefined, undefined, ['analyzing']),
  row('run one named agent', [R, 'control:analyze-agent', 'control:analyze-agent-one']),
  row('clear the reference search', [C, 'section:references', 'control:clear-reference-filter'], 5, [C, 'typein:Search references…|zz', 'icon:x'], ['sources', 'citations']),
  row('filter suggestions to one severity', [R, 'control:filter', 'control:filter-severity'], undefined, undefined, ['suggestion']),
  row('run a single agent', [R, 'control:analyze-agent']),
  row('summarize the manuscript and its gaps', [R, 'control:summary']),
  // Format
  row('pick a grant template', [F, 'section:template'], 7, ['title:Grant mode*', 'title:Start from an NIH grant template', 'css:[aria-label="Choose grant template"]']),
  row('edit grant instructions', [F, 'section:template', 'control:instructions'], 7, ['title:Grant mode*', 'title:Add funder instructions*', 'css:[aria-label="Grant instructions"]']),
  row('see grant section page budgets', [F, 'section:template', 'control:budgets'], 7, ['title:Grant mode*', 'htext:*/1 pg'], ['grant']),
  row('trim an over-budget section', [F, 'section:template', 'control:trim'], 7, ['title:Grant mode*', 'htext:Trim'], ['grant']),
  row('switch between manuscript and grant mode', [F, 'section:template', 'control:mode'], 7, ['title:Grant mode*']),
  fresh('set page margins', [F, 'section:page'], 7),
  fresh('choose a format preset', [F, 'section:page', 'control:preset'], 7),
  fresh('edit a named style', [F, 'section:styles'], 7),
  // File and document (top bar)
  row('start a new manuscript', ['topbar:file', 'item:new'], 8, ['title:New Manuscript']),
  row('import a Word, JSON, Markdown or text file', ['topbar:file', 'item:import'], 8, ['text:Load Document (.json, .docx, .md, .txt)']),
  row('see the import report again', ['topbar:file', 'item:import-report'], 8, ['text:Import report*', 'text:Import report'], ['import']),
  row('restore the previous document', ['topbar:file', 'item:revert-import'], 8, ['text:Restore previous document*'], ['import']),
  row('save a workspace file', ['topbar:file', 'item:save-workspace'], 8, ['text:Save Workspace']),
  row('export Markdown', ['topbar:file', 'item:export-md'], 8, ['text:Export Markdown']),
  row('export Word', ['topbar:file', 'item:export-docx'], 8, ['text:Export Word']),
  row('export LaTeX', ['topbar:file', 'item:export-tex'], 8, ['text:Export to LaTeX (.zip)']),
  row('undo', ['topbar:file', 'item:undo'], 8, ['title:Undo']),
  row('redo', ['topbar:file', 'item:redo'], 8, ['title:Redo']),
  row('rename the document', ['topbar:title'], 8, ['ph:Untitled Manuscript']),
  row('open settings', ['topbar:overflow', 'item:settings'], 8, ['icon:settings', 'text:AI Configuration']),
  row('draft a rebuttal or cover letter', ['topbar:overflow', 'item:post-drafting'], 8, ['title:Post-Drafting: Rebuttal & Cover Letter', 'text:Post-Drafting Assistant']),
  row('read the keyboard shortcuts', ['topbar:overflow', 'item:shortcuts'], 8, ['title:Keyboard Shortcuts']),
  row('toggle dark mode', ['topbar:overflow', 'item:dark-mode'], 8, ['title:Dark Mode']),
  row('enter focus mode', ['topbar:overflow', 'item:focus-mode'], 8, ['title:Focus Mode']),
  row('zoom out', ['topbar:overflow', 'item:zoom-out'], 8, ['title:Zoom Out']),
  row('zoom in', ['topbar:overflow', 'item:zoom-in'], 8, ['title:Zoom In']),
  // Status
  row('read the page estimate', ['status:pages'], undefined, undefined),
  row('read the word count', ['status:words'], undefined, undefined),
  row('read the save state', ['status:save'], undefined, undefined),
  row('read the token estimate and provider', ['status:tokens'], 8, ['stext:*tokens']),
  row('read characters, paragraphs and reading time', ['status:stats'], 8, ['ctext:*min read']),
  row('analyze the section the cursor is in', ['topbar:ai', 'item:analyze-section'], 8, ['title:Analyze "Intro" section only'], ['outline']),
  // Text formatting and insert (top bar)
  ...[['bold', 'Bold'], ['italic', 'Italic'], ['underline', 'Underline'], ['heading 2', 'Heading 2'], ['heading 3', 'Heading 3'], ['bullet list', 'Bullet list'],
    ['numbered list', 'Numbered list'], ['blockquote', 'Blockquote'], ['align left', 'Align left'], ['center text', 'Center'], ['justify text', 'Justify'],
  ].map(([f, t]) => row(`format text: ${f}`, ['topbar:format', `control:${f.replace(' ', '-')}`], 8, [`title:${t}`])),
  row('toggle AI autocomplete', ['topbar:ai', 'item:autocomplete'], 8, ['title:Autocomplete*']),
  row('insert a figure', ['topbar:insert', 'item:figure'], 8, ['title:Insert figure / image']),
  row('insert a figure label', ['topbar:insert', 'item:figure-label'], 8, ['title:Insert figure label (auto-numbered)']),
  row('insert a table', ['topbar:insert', 'item:table'], 8, ['title:Insert table']),
  // AI on the selection
  ...['Polish', 'Shorten', 'Sharpen', 'Strengthen', 'Critique', 'Explain'].map(l =>
    row(`${l.toLowerCase()} the selection`, ['topbar:ai', `item:${l.toLowerCase()}`], 8, [`title:${l} —*`], ['text-selection'])),
  row('rewrite the selection', ['topbar:ai', 'item:rewrite'], 8, ['title:Rewrite and get accept/reject suggestion'], ['text-selection']),
  row('give a custom instruction', ['topbar:ai', 'item:instruct'], 8, ['title:Custom instruction for selected text'], ['text-selection']),
  row('find synonyms', ['topbar:ai', 'item:synonyms'], 8, ['title:Find synonyms / alternatives'], ['word-selection']),
  row('verify a claim against sources', ['topbar:ai', 'item:verify'], 8, ['title:Verify this claim against uploaded PDF sources'], ['text-selection']),
  row('replace a word with a synonym', ['topbar:ai', 'item:synonym-choice'], 8, ['title:Find synonyms / alternatives', 'text:SYNONYM_X', 'expect:doctext:SYNONYM_X'], ['word-selection']),
  row('bold the selection from the selection menu', ['topbar:format', 'control:bold-selection'], 8, ['icon:bold#2'], ['text-selection']),
  row('italicize the selection from the selection menu', ['topbar:format', 'control:italic-selection'], 8, ['icon:italic#2'], ['text-selection']),
  row('underline the selection from the selection menu', ['topbar:format', 'control:underline-selection'], 8, ['icon:underline#2'], ['text-selection']),
  row('send a custom instruction', ['topbar:ai', 'item:instruct-send'], 8, ['title:Custom instruction for selected text', 'icon:send'], ['text-selection']),
  row('find similar manuscripts', ['topbar:ai', 'item:similar'], 8, ['title:Find similar published manuscripts for this selection'], ['text-selection']),
  // AI and layout on the selected figure
  row('describe a figure', ['figure:selected', 'control:describe'], 8, ['title:Visual description of what is seen in the figure'], ['figure']),
  row('check figure quality', ['figure:selected', 'control:quality'], 8, ['title:Check figure quality, spelling, colors, readability'], ['figure']),
  row('review figure relevance', ['figure:selected', 'control:relevance'], 8, ['title:Review figure relevance and clarity in context of manuscript'], ['figure']),
  row('type a question about a figure', ['figure:selected', 'control:ask-text'], 8, ['title:Ask a custom question about this figure', 'ph:Ask about this figure…*'], ['figure']),
  row('ask about a figure', ['figure:selected', 'control:ask'], 8, ['title:Ask a custom question about this figure'], ['figure']),
  row('align a figure', ['figure:selected', 'control:align-figure'], 8, ['title:Align center'], ['figure']),
  row('resize a figure', ['figure:selected', 'control:size-figure'], 8, ['title:Set width to 50%'], ['figure']),
  row('delete a figure', ['figure:selected', 'control:delete-figure'], 8, ['title:Delete figure'], ['figure']),

  // ── Round 1: the interactions, keyboard bindings and Cite/Editor details the first pass left out ──
  // Cite
  row('run a literature search', [C, 'section:search', 'control:run-search'], 5, [C, 'typein:Title, keywords, or paste abstract…|crispr screens', 'ptext:Search', 'ptext:Mock paper 1 on screens']),
  row('add a search result to the library', [C, 'section:search', 'control:add-result'], 5, [C, 'typein:Title, keywords, or paste abstract…|crispr screens', 'ptext:Search', 'ptext:Add source', 'expect:source:Mock paper 1 on screens']),
  row('choose the bibliography style', [C, 'section:references', 'control:bib-style'], 5, [C, 'select:Vancouver'], ['sources']),
  row('sort the reference list', [C, 'section:references', 'control:sort-references'], 5, [C, 'select:Year'], ['sources', 'citations']),
  row('expand a reference row', [C, 'section:references', 'control:expand-reference'], 5, [C, 'ptext:More'], ['sources', 'citations']),
  row('confirm a PDF match', [C, 'section:library', 'control:match-yes'], 5, [C, 'typein:Search paper title or keywords…|crispr screens', 'ptext:Search#2', 'ptext:Yes, this is it', 'expect:source:Mock paper 1 on screens'], ['sources']),
  row('try the next PDF match', [C, 'section:library', 'control:match-next'], 5, [C, 'typein:Search paper title or keywords…|crispr screens', 'ptext:Search#2', 'ptext:Try next', 'ptext:Is this your paper? (2/2)'], ['sources']),
  row('dismiss a PDF match', [C, 'section:library', 'control:match-dismiss'], 5, [C, 'typein:Search paper title or keywords…|crispr screens', 'ptext:Search#2', 'ptext:Dismiss', 'gone:Is this your paper?*'], ['sources']),
  row('switch a PDF between summary and abstract', [C, 'section:library', 'control:source-tabs'], 5, [C, 'ptext:abstract#1', 'ptext:abs'], ['sources']),
  row('re-extract a PDF abstract', [C, 'section:library', 'control:reextract-abstract'], 5, [C, 'ptext:abstract#1', 'title:Re-extract abstract'], ['sources']),
  row('drop files on the sources area', [C, 'section:library', 'control:dropzone'], 5, [C, 'dropcss:.border-dashed|notes.txt', 'ptext:notes.txt']),
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
  row('click an applied change to find it in the text', [W, 'section:history', 'control:locate'], 6, [W, 'section:history', 'ptext:Alpha → beta gamma', 'expect:selection:beta gamma'], ['history', 'outline']),
  row('run an analysis from the top bar', ['topbar:ai', 'item:analyze'], 8, ['htext:Analyze All']),
  row('run a single agent from the top bar', ['topbar:ai', 'item:analyze-agent'], 8, ['nextto:Analyze All*', 'htext:Run Single Agent']),
  row('run one named agent from the top bar', ['topbar:ai', 'item:analyze-agent-one'], 8, ['nextto:Analyze All*', 'htext:Language Surgeon']),
  row('summarize from the top bar', ['topbar:ai', 'item:summary'], 8, ['title:Generate a high-level manuscript review*']),
  row('stop an analysis from the top bar', ['topbar:ai', 'item:stop'], 8, ['rail:cite', 'htext:Stop'], ['analyzing']),
  row('confirm the export warning and download', ['topbar:file', 'item:export-confirm'], 8, ['text:Export Markdown', 'mtext:I Acknowledge — Download']),
  row('cancel the export warning', ['topbar:file', 'item:export-cancel'], 8, ['text:Export Markdown', 'mtext:Cancel']),
  row('close the shortcuts list', ['topbar:overflow', 'item:shortcuts-close'], 8, ['title:Keyboard Shortcuts', 'mtext:Close']),
  row('measure my voice from pasted samples', [R, 'section:style', 'control:voice-samples', 'control:voice-measure']),
  row('cancel adding voice samples', [R, 'section:style', 'control:voice-samples', 'control:voice-cancel']),
  row('rebuild the voice profile', [R, 'section:style', 'control:voice-rebuild'], undefined, undefined, ['voice-profile']),
  row('remove the voice profile', [R, 'section:style', 'control:voice-remove'], undefined, undefined, ['voice-profile']),
  // Editor internals that stay in the Editor: their rows are settled, so a move must edit the row
  row('click a highlighted passage to open its suggestion', ['rail:cite', 'markclick:', 'ptext:Accept'], undefined, undefined, ['suggestion', 'outline']),
  row('pick a table size', ['title:Insert table', 'css:#table-picker-portal div[style*="cursor"]#9', 'expect:table:2x3']),
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
  row('choose the agent for a custom instruction', ['topbar:ai', 'item:instruct-agent'], 8, ['title:Custom instruction for selected text', 'select:Reviewer 2'], ['text-selection']),
  row('type a custom instruction', ['topbar:ai', 'item:instruct-text'], 8, ['title:Custom instruction for selected text', 'ph:e.g. Make this more concise...'], ['text-selection']),
  row('read the character count', ['status:chars'], 8, ['ctext:*chars']),
  row('read the paragraph count', ['status:paragraphs'], 8, ['ctext:*paragraphs']),
  row('resize the side panel', [R, 'css:.cursor-col-resize', 'drag:-100', 'expect:panelwidth:500px']),
  // Keyboard bindings: independently losable, so each has its own row
  row('use the restore button on the import message', ['topbar:file', 'item:import-toast-action'], 8, ['importdocx:body-basics.docx', 'css:.toast-enter button', 'text:*Restored the document the import replaced*'], ['saved-doc']),
  row('save the workspace with Ctrl/Cmd+S', ['keyhandled:Mod+S']),
  row('analyze with Ctrl/Cmd+Shift+A', ['keyhandled:Mod+Shift+A']),
  row('show the shortcuts with Ctrl/Cmd+?', ['key:Mod+?', 'mtext:Ctrl+Shift+A']),
  row('bold with Ctrl+B', ['key:Ctrl+B', 'expect:bold'], undefined, undefined, ['text-selection']),
  row('italic with Ctrl+I', ['key:Ctrl+I', 'expect:italic'], undefined, undefined, ['text-selection']),
  row('underline with Ctrl+U', ['key:Ctrl+U', 'expect:underline'], undefined, undefined, ['text-selection']),
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
    click(el); await settle(0); return;
  }
  if (kind === 'item' || kind === 'control' || kind === 'row') {
    const el = await waitStep(spec, () => candidates('testid', `${kind}-${arg}`)[0]);
    if (!isLast) click(el); else expect(enabled(el), `${spec} is disabled`).toBe(true);
    return;
  }
  if (kind === 'figure') { await waitStep(spec, () => candidates('text', 'Figure AI')[0]); return; }
  if (kind === 'status') {
    const want = { pages: /^~?\d+ (pp|of \d+)$/, words: /^[\d,]+ words$/, save: /^(Draft|Saved|Auto-saved)$/ }[arg];
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
  'Manuscript AI Editor': 'logo tooltip', 'VC by Dawid Zyla — github.com/dzyla/manuscriptAI': 'credit link',
  'AI may make mistakes. Researcher is responsible for scientific correctness.': 'static notice', 'Text Zoom': 'readout between the zoom buttons',
  'Manuscript mode — journal-style agents': 'the other half of the mode toggle (row: switch between manuscript and grant mode)',
  'Light Mode': 'the other state of the dark-mode toggle (row: toggle dark mode)',
  'Remove image': 'chip on an attached chat image (rows: drop/paste an image into chat)',
  'Copy to My Templates for editing': 'inside the template picker, which moves whole (row: pick a grant template)',
  'Page limit (blank = none)': 'inside the template picker, which moves whole',
  'Saved ': 'tooltip on the Restore previous document item (row: restore the previous document)',
  'Over the ': 'tooltip on Trim (row: trim an over-budget section)',
  'In section: ': 'tooltip on the section indicator in the stats bar (row: analyze the section the cursor is in)',
  'Query: ': 'tooltip on a literature-search source card',
  'Funder instructions active — all agents follow them': 'the other state of the instructions toggle (row: edit grant instructions)',
  'Analyze "': 'tooltip form of the Analyze Section controls (rows: analyze one section / the section the cursor is in)',
};
/** Template titles that start with an expression, so there is no prefix to match; each is covered by the rows named. */
const TEMPLATE_TITLES: Record<string, string> = {
  '${action.label} — ${action.mode': 'rows: polish/shorten/sharpen/strengthen/critique/explain the selection',
  '${ts.title}: ${words}': 'tooltip on a grant budget chip (row: see grant section page budgets)',
  '${src.name}': 'tooltip on an attached source (row: choose which sources the chat sees)',
};
/** Buttons whose only label is an icon (no title, no text): the guard cannot name them, so it counts them. A new one fails until a row covers it (an `icon:` step) and this count moves. */
const ICON_ONLY_BUTTONS: Record<string, number> = {
  // App 5: Download menu trigger (its items have rows), Settings, analyze-menu chevron, each agent in that menu (named by its label), the toast action.
  'src/App.tsx': 5,
  // Editor 9: mobile toolbar toggle (a phone-width control, `sm:hidden`, not reachable at desktop width by design), bubble Bold/Italic/Underline, synonym chips,
  // custom-instruction send, figure-question send, table menu items and @-picker sources (each has rows).
  'src/components/Editor.tsx': 9,
  // Sidebar 8: tab bar, the inline chat suggestion cards' accept/reject, clear-reference-search, trash, source tabs, PDF tabs, agent chips, vision X, send.
  // (Task 4 moved the severity filter and the suggestion cards' own buttons to the Review panel, which names its controls with test ids.)
  'src/components/Sidebar.tsx': 8,
  'src/components/style/StylePanel.tsx': 1, // jump to a flagged sentence
  'src/components/style/VoiceProfileManager.tsx': 0,
  'src/components/panels/ReviewPanel.tsx': 4, // section toggles (rows: read the style comparison / open chat), severity chips, row action buttons, named-agent items
  'src/components/panels/SuggestionBody.tsx': 0, 'src/components/panels/suggestionParts.tsx': 0,
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
    if (m[1]) out.push(m[1]); else out.push(...literals(balanced(tag, m.index! + m[0].length - 1) ?? ''));
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
const GUARDED = ['src/App.tsx', 'src/components/Editor.tsx', 'src/components/Sidebar.tsx', 'src/components/style/StylePanel.tsx', 'src/components/style/VoiceProfileManager.tsx',
  'src/components/panels/ReviewPanel.tsx', 'src/components/panels/SuggestionBody.tsx', 'src/components/panels/suggestionParts.tsx'];

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
  it('a test id belongs to one control across the guarded files, so a step cannot vouch for a different button that reuses its name', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const f of GUARDED) {
      const src = source(f);
      for (const m of src.matchAll(/data-testid=/g)) for (const id of testidsIn(tagAt(src, m.index!))) {
        if (id.includes('$')) continue;
        const prev = seen.get(id);
        if (prev !== undefined && prev !== `${f}:${tagAt(src, m.index!)}`) dupes.push(`${id} (${prev.split(':')[0]} and ${f})`);
        seen.set(id, `${f}:${tagAt(src, m.index!)}`);
      }
    }
    expect(dupes).toEqual([]);
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
  it.each(ENTRY_POINTS.filter(e => e.pending && e.now))('$feature (Task $pending)', async (e) => { await expect(resolve(e.now!, e.seed)).resolves.toBe(true); }, 30000);
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

  it('the rail decides what is open; closing it stays closed and a tab change moves both together', async () => {
    await mount();
    const open = (n: string) => railBtn(n).getAttribute('aria-pressed') === 'true';
    fireEvent.click(railBtn('Format'));
    expect(open('Format')).toBe(true);
    await waitStep('format opens the Style tab', () => screen.queryByText(/compare the draft with your own writing style|Highlight flagged/));
    fireEvent.click(railBtn('Format')); // the active task again closes the panel
    expect(open('Format')).toBe(false);
    expect(panel().hasAttribute('hidden')).toBe(true);
    await settle(200); // a tab-to-rail effect would reopen it here
    expect(open('Format') || open('Write') || open('Cite') || open('Review')).toBe(false);
    expect(panel().hasAttribute('hidden')).toBe(true);
    fireEvent.click(railBtn('Cite')); // reopening from closed opens that task on its own tab
    expect(open('Cite')).toBe(true);
    await waitStep('cite opens Sources', () => screen.queryByText('Browse files'));
    fireEvent.click(screen.getByTestId('section-outline')); // a legacy tab change moves the rail with it
    expect(open('Write')).toBe(true);
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
  it('after jumping to a citation', async () => { await unmountWhilePending([C], ['sources', 'citations', 'cited-text'], 'title:Jump to citation in document'); }, 20000);
});
