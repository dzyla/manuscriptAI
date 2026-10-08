// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { RailTask } from './Rail';

// Environment stand-ins, not feature stubs: pdfjs needs canvas, Worker and layout do not exist in jsdom. Nothing a row looks for is faked.
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn(), version: 'test' }));
import App from '../../App';
import { db } from '../../db/manuscriptDb';
import { useAIStore } from '../../stores/useAIStore';
import { useSourceStore } from '../../stores/useSourceStore';
import { useDocumentStore, documentRepository } from '../../stores/useDocumentStore';
import { readDocx } from '../../docx/read';
import { loadDocx } from '../../test/docxFixtures';
import { htmlToDoc } from '../../extensions/schema';
import { createFormat } from '../../services/formatPresets';

class InertWorker { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }
const noRects: any = () => Object.assign([], { item: () => null });
beforeAll(() => {
  (globalThis as any).Worker = InertWorker;
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
 */
export type Seed = 'import' | 'snapshot' | 'grant' | 'suggestion' | 'history' | 'sources' | 'citations' | 'outline' | 'analyzing' | 'style-text' | 'text-selection' | 'word-selection' | 'figure';
export interface EntryPoint { feature: string; path: string[]; pending?: number; now?: string[]; isNew?: true; seed?: Seed[] }

const W = 'rail:write', C = 'rail:cite', R = 'rail:review', F = 'rail:format';
const row = (feature: string, path: string[], pending?: number, now?: string[], seed?: Seed[]): EntryPoint =>
  ({ feature, path, ...(pending ? { pending } : {}), ...(now ? { now } : {}), ...(seed ? { seed } : {}) });
const fresh = (feature: string, path: string[], pending: number): EntryPoint => ({ feature, path, pending, isNew: true });

export const ENTRY_POINTS: EntryPoint[] = [
  // Write
  row('see the outline', [W, 'section:outline'], undefined, undefined, ['outline']),
  row('jump to a heading from the outline', [W, 'section:outline', 'control:goto-heading'], 6, [W, 'section:outline', 'text:Intro'], ['outline']),
  row('analyze one section from the outline', [W, 'section:outline', 'control:analyze-section'], 6, [W, 'section:outline', 'title:Analyze "Intro" section'], ['outline']),
  row('see applied-suggestion history', [W, 'section:history'], undefined, undefined, ['history']),
  row('inspect an applied change', [W, 'section:history', 'control:show-changes'], 6, [W, 'section:history', 'title:Show changes'], ['history']),
  row('revert an applied change', [W, 'section:history', 'control:revert-change'], 6, [W, 'section:history', 'title:Show changes', 'text:Revert Change'], ['history']),
  row('restore a version snapshot', [W, 'section:versions', 'control:restore-version'], 6, ['title:Version History', 'title:Restore'], ['snapshot']),
  row('save a version snapshot', [W, 'section:versions', 'control:save-version'], 6, ['title:Version History', 'title:Save snapshot']),
  row('preview a version snapshot', [W, 'section:versions', 'control:preview-version'], 6, ['title:Version History', 'title:Preview'], ['snapshot']),
  row('delete a version snapshot', [W, 'section:versions', 'control:delete-version'], 6, ['title:Version History', 'title:Delete'], ['snapshot']),
  // Cite
  row('upload a PDF, DOCX, BibTeX or text source', [C, 'section:library', 'control:upload'], 5, [C, 'text:Browse files']),
  row('add a source by DOI', [C, 'section:library', 'control:doi'], 5, [C, 'ph:10.1234/journal.article']),
  row('remove a source', [C, 'section:library', 'control:remove-source'], 5, [C, 'icon:trash-2'], ['sources']),
  row('regenerate a source summary', [C, 'section:library', 'control:regenerate-summary'], 5, [C, 'title:Regenerate AI summary'], ['sources']),
  row('copy a source as BibTeX', [C, 'section:library', 'control:copy-bibtex'], 5, [C, 'title:Copy BibTeX entry to clipboard'], ['sources']),
  row('compare a source with the manuscript', [C, 'section:library', 'control:compare-source'], 5, [C, 'text:Compare'], ['sources']),
  row('chat about one source', [C, 'section:library', 'control:chat-source'], 5, [C, 'text:Chat#2'], ['sources']),
  row('check a source against the citations', [C, 'section:library', 'control:check-citations'], 5, [C, 'text:Check Citations'], ['sources']),
  row('find the published record of a PDF', [C, 'section:library', 'control:match-pdf'], 5, [C, 'ph:Search paper title or keywords…'], ['sources']),
  row('search the literature', [C, 'section:search', 'control:query'], 5, [C, 'ph:Title, keywords, or paste abstract…']),
  row('format a bibliography from a BibTeX source', [C, 'section:references', 'control:format-bibliography'], 5, [C, 'text:Insert'], ['sources']),
  row('renumber citations', [C, 'section:references', 'control:renumber'], 5, [C, 'title:Renumber citations in document order'], ['sources', 'citations']),
  row('search the reference list', [C, 'section:references', 'control:filter-references'], 5, [C, 'ph:Search references…'], ['sources', 'citations']),
  row('jump to a citation in the document', [C, 'section:references', 'control:goto-citation'], 5, [C, 'title:Jump to citation in document'], ['sources', 'citations']),
  row('jump to the first citation of a source', [C, 'section:references', 'control:first-citation'], 5, [C, 'title:Jump to first citation'], ['sources', 'citations']),
  row('remove a citation', [C, 'section:references', 'control:remove-citation'], 5, [C, 'title:Remove citation'], ['sources', 'citations']),
  row('insert the reference list', [C, 'section:references', 'control:insert-reference-list'], 5, [C, 'text:Insert reference list'], ['sources', 'citations']),
  row('insert a citation with @', ['topbar:insert', 'item:citation'], 8, ['key:@', 'text:Insert Citation']),
  // Review
  row('open chat', [R, 'section:chat']),
  row('send a chat message', [R, 'section:chat', 'control:send'], 4, [R, 'section:chat', 'fill:hello', 'icon:send']),
  row('switch between Manuscript AI and agents', [R, 'section:chat', 'control:agent-mode'], 4, [R, 'section:chat', 'text:Agents']),
  row('read what each agent does', [R, 'section:chat', 'control:agent-info'], 4, [R, 'section:chat', 'title:Show agent descriptions']),
  row('attach an image to a chat message', [R, 'section:chat', 'control:attach-image'], 4, [R, 'section:chat', 'title:Attach image (JPEG, PNG, WebP)']),
  row('choose which sources the chat sees', [R, 'section:chat', 'control:attach-sources'], 4, [R, 'section:chat', 'title:Attach context sources']),
  row('accept a suggestion', [R, 'row:suggestion', 'control:accept'], 4, [R, 'section:suggestions', 'text:Accept'], ['suggestion']),
  row('reject a suggestion', [R, 'row:suggestion', 'control:reject'], 4, [R, 'section:suggestions', 'text:Reject'], ['suggestion']),
  row('accept every suggestion', [R, 'control:accept-all'], 4, [R, 'section:suggestions', 'text:Accept All'], ['suggestion']),
  row('clear every suggestion', [R, 'control:reject-all'], 4, [R, 'section:suggestions', 'text:Clear All'], ['suggestion']),
  row('disagree with a suggestion and reply', [R, 'row:suggestion', 'control:rebut'], 4, [R, 'section:suggestions', 'text:Disagree? Reply to this suggestion...'], ['suggestion']),
  row('rewrite a flagged sentence', [R, 'row:style', 'control:rewrite'], 4, [F, 'section:style', 'text:Rewrite in my voice'], ['style-text']),
  row('jump to a flagged sentence', [R, 'row:style', 'control:goto'], 4, [F, 'section:style', 'text:*words ·*'], ['style-text']),
  row('read the style comparison', [R, 'section:style'], 4, [F, 'section:style', 'text:Highlight flagged sentences in the editor'], ['style-text']),
  row('add writing samples for the voice profile', [R, 'section:style', 'control:voice-samples'], 4, [F, 'section:style', 'text:Add samples']),
  row('filter suggestions by severity', [R, 'control:filter'], 4, [R, 'section:suggestions', 'icon:funnel'], ['suggestion']),
  row('run an analysis', [R, 'control:analyze'], 4, ['text:Analyze All']),
  row('stop a running analysis', [R, 'control:stop'], 4, ['title:Stop request'], ['analyzing']),
  row('run a single agent', [R, 'control:analyze-agent'], 4, ['nextto:Analyze All*', 'text:Run Single Agent']),
  row('summarize the manuscript and its gaps', [R, 'control:summary'], 4, ['title:Generate a high-level manuscript review*']),
  // Format
  row('pick a grant template', [F, 'section:template'], 7, ['text:Grant', 'title:Start from an NIH grant template']),
  row('edit grant instructions', [F, 'section:template', 'control:instructions'], 7, ['text:Grant', 'title:Add funder instructions*']),
  row('see grant section page budgets', [F, 'section:template', 'control:budgets'], 7, ['text:Grant', 'text:Specific Aims'], ['grant']),
  row('trim an over-budget section', [F, 'section:template', 'control:trim'], 7, ['text:Grant', 'text:Trim'], ['grant']),
  row('switch between manuscript and grant mode', [F, 'section:template', 'control:mode'], 7, ['title:Grant mode*']),
  fresh('set page margins', [F, 'section:page'], 7),
  fresh('choose a format preset', [F, 'section:page', 'control:preset'], 7),
  fresh('edit a named style', [F, 'section:styles'], 7),
  // File and document (top bar)
  row('start a new manuscript', ['topbar:file', 'item:new'], 8, ['title:New Manuscript']),
  row('import a Word, JSON, Markdown or text file', ['topbar:file', 'item:import'], 8, ['text:Load Document (.json, .docx, .md, .txt)']),
  row('see the import report again', ['topbar:file', 'item:import-report'], 8, ['text:Import report*'], ['import']),
  row('restore the previous document', ['topbar:file', 'item:revert-import'], 8, ['text:Restore previous document*'], ['import']),
  row('save a workspace file', ['topbar:file', 'item:save-workspace'], 8, ['text:Save Workspace']),
  row('export Markdown', ['topbar:file', 'item:export-md'], 8, ['text:Export Markdown']),
  row('export Word', ['topbar:file', 'item:export-docx'], 8, ['text:Export Word']),
  row('export LaTeX', ['topbar:file', 'item:export-tex'], 8, ['text:Export to LaTeX (.zip)']),
  row('undo', ['topbar:file', 'item:undo'], 8, ['title:Undo']),
  row('redo', ['topbar:file', 'item:redo'], 8, ['title:Redo']),
  row('rename the document', ['topbar:title'], 8, ['ph:Untitled Manuscript']),
  row('open settings', ['topbar:overflow', 'item:settings'], 8, ['icon:settings']),
  row('draft a rebuttal or cover letter', ['topbar:overflow', 'item:post-drafting'], 8, ['title:Post-Drafting: Rebuttal & Cover Letter']),
  row('read the keyboard shortcuts', ['topbar:overflow', 'item:shortcuts'], 8, ['title:Keyboard Shortcuts']),
  row('toggle dark mode', ['topbar:overflow', 'item:dark-mode'], 8, ['title:Dark Mode']),
  row('enter focus mode', ['topbar:overflow', 'item:focus-mode'], 8, ['title:Focus Mode']),
  row('zoom out', ['topbar:overflow', 'item:zoom-out'], 8, ['title:Zoom Out']),
  row('zoom in', ['topbar:overflow', 'item:zoom-in'], 8, ['title:Zoom In']),
  // Status
  row('read the page estimate', ['status:pages'], undefined, undefined),
  row('read the word count', ['status:words'], undefined, undefined),
  row('read the save state', ['status:save'], undefined, undefined),
  row('read the token estimate and provider', ['status:tokens'], 8, ['text:*tokens']),
  row('read characters, paragraphs and reading time', ['status:stats'], 8, ['text:*min read']),
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
  row('find similar manuscripts', ['topbar:ai', 'item:similar'], 8, ['title:Find similar published manuscripts for this selection'], ['text-selection']),
  // AI and layout on the selected figure
  row('describe a figure', ['figure:selected', 'control:describe'], 8, ['title:Visual description of what is seen in the figure'], ['figure']),
  row('check figure quality', ['figure:selected', 'control:quality'], 8, ['title:Check figure quality, spelling, colors, readability'], ['figure']),
  row('review figure relevance', ['figure:selected', 'control:relevance'], 8, ['title:Review figure relevance and clarity in context of manuscript'], ['figure']),
  row('ask about a figure', ['figure:selected', 'control:ask'], 8, ['title:Ask a custom question about this figure'], ['figure']),
  row('align a figure', ['figure:selected', 'control:align-figure'], 8, ['title:Align center'], ['figure']),
  row('resize a figure', ['figure:selected', 'control:size-figure'], 8, ['title:Set width to 50%'], ['figure']),
  row('delete a figure', ['figure:selected', 'control:delete-figure'], 8, ['title:Delete figure'], ['figure']),
];

/** Deliberately not entry points. */
export const EXCLUDED = [
  { feature: 'editorWidth (normal/wide/full)', reason: 'removed by design: the page is the width (spec §2)' },
  { feature: 'second version-history component (VersionHistoryPanel)', reason: 'unused duplicate, deleted in Task 6 (plan), spec §5' },
];

// ── Resolver ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const matches = (actual: string, want: string) => {
  const star = (w: string, a: string) => (w.startsWith('*') && w.endsWith('*') && w.length > 1 ? a.includes(w.slice(1, -1)) : w.endsWith('*') ? a.startsWith(w.slice(0, -1)) : w.startsWith('*') ? a.endsWith(w.slice(1)) : a === w);
  return star(want, actual);
};

/** Hidden by the `hidden` attribute, aria-hidden, inert, inline display/visibility, or a Tailwind `hidden` with no responsive or hover reveal. jsdom has no layout, so zero-size is not detectable. */
export function isShown(el: Element): boolean {
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    const s = (e as HTMLElement).style;
    if (e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('inert')) return false;
    if (s?.display === 'none' || s?.visibility === 'hidden') return false;
    const cls = (e.getAttribute('class') ?? '').split(/\s+/);
    if (cls.includes('hidden') && !cls.some(c => /^(sm|md|lg|xl|group-hover):(block|flex|inline|inline-flex|grid)/.test(c))) return false;
  }
  return true;
}

const innermost = (els: Element[]) => els.filter(e => !els.some(o => o !== e && e.contains(o)));
function candidates(kind: string, arg: string): Element[] {
  const all = (sel: string) => [...document.querySelectorAll(sel)];
  const [want, nth] = arg.includes('#') ? [arg.slice(0, arg.lastIndexOf('#')), Number(arg.slice(arg.lastIndexOf('#') + 1))] : [arg, 0];
  let found: Element[] = [];
  if (kind === 'title') found = all('[title]').filter(e => matches(e.getAttribute('title')!, want));
  else if (kind === 'ph') found = all('[placeholder]').filter(e => matches(e.getAttribute('placeholder')!, want));
  else if (kind === 'testid') found = all('[data-testid]').filter(e => e.getAttribute('data-testid') === want);
  else if (kind === 'icon') found = all(`svg.lucide-${want}`).map(e => e.closest('button') ?? e);
  else if (kind === 'text') found = innermost(all('body *').filter(e => !/^(SCRIPT|STYLE|OPTION|SVG|PATH)$/i.test(e.tagName) && matches(norm(e.textContent), want)));
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
const click = (el: Element) => fireEvent.click(el);
const editor = () => (document.querySelector('.ProseMirror') as any)?.editor;
const settle = (ms = 150) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function step(spec: string, isLast: boolean): Promise<void> {
  const i = spec.indexOf(':');
  const kind = spec.slice(0, i), arg = spec.slice(i + 1);
  if (kind === 'rail') {
    const name = arg[0].toUpperCase() + arg.slice(1);
    const btn = await waitStep(spec, () => screen.queryAllByRole('button').find(b => (b.getAttribute('aria-label') ?? '').startsWith(`${name} —`)));
    if (btn.getAttribute('aria-pressed') !== 'true') click(btn); // a pressed task is open already; clicking it would close the panel
    await waitStep(`${spec}: its panel is open and visible`, () => { const a = document.querySelector('aside.u-shell-panel'); return a && isShown(a) && a.getAttribute('data-task') === arg; });
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
  if (kind === 'key') { fireEvent.keyDown(editor().view.dom, { key: arg }); return; }
  if (kind === 'fill') {
    const box = await waitStep(spec, () => candidates('testid', 'chat-input')[0] ?? [...document.querySelectorAll('aside textarea')].find(isShown));
    fireEvent.change(box, { target: { value: arg } }); return;
  }
  const el = await waitStep(spec, () => candidates(kind, arg)[0]);
  if (!isLast) { click(el); await settle(0); } else expect(enabled(el), `${spec} is disabled`).toBe(true);
}

const seedBefore = async (seeds: Seed[] = []) => {
  if (seeds.includes('import')) {
    const r = await readDocx(loadDocx('body-basics.docx'), undefined, 'body-basics.docx');
    await documentRepository.importDocx(r, { title: 'First' });
    await documentRepository.importDocx(r, { title: 'Second' }); // the second import replaces the first, which leaves a restorable backup
  }
  if (seeds.includes('snapshot')) await db.versionSnapshots.add({ id: 'v1', name: 'Draft 1', timestamp: Date.now(), title: 'T', content: '<p>x</p>', wordCount: 1 });
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
    if (seeds.includes('analyzing')) useAIStore.setState({ isAnalyzing: true });
    if (seeds.includes('suggestion')) useAIStore.setState({ suggestions: [{ id: 's1', originalText: 'Alpha', suggestedText: 'Beta', explanation: 'x', agent: 'editor', startIndex: 0, endIndex: 5, severity: 'minor' } as any] });
    if (seeds.includes('history')) useAIStore.setState({ history: [{ id: 'h1', timestamp: 1, oldContent: '<p>a</p>', newContent: '<p>b</p>', originalText: 'a', suggestedText: 'b', suggestionId: 's1', agent: 'editor' }] });
    if (seeds.includes('sources')) useSourceStore.setState({ sources: [
      { id: 'p1', name: 'paper.pdf', type: 'pdf', text: 'Body text of the paper', digest: 'dig', abstractText: 'abs' },
      { id: 'a1', name: 'API one', type: 'api', text: 'x', digest: 'dig2', apiMeta: { title: 'T', authors: 'A B', journal: 'J', doi: '10.1/x', abstract: 'abs', year: 2020, score: 1, source: 'PubMed' } },
      { id: 'b1', name: 'refs.bib', type: 'bib', text: '@article{k, title={T}, author={A}, year={2020}, journal={J}}' },
    ] });
    if (seeds.includes('citations')) useDocumentStore.setState({ citationRegistry: { a1: 1 }, citationCounter: 1 });
    const ed = editor();
    if (seeds.includes('outline') || seeds.includes('text-selection') || seeds.includes('word-selection')) ed.commands.setContent(POEM);
    if (seeds.includes('style-text')) ed.commands.setContent(STYLE_TEXT);
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
/** Titles that name no feature: static notices, readouts, or a part of a control that a row already covers. */
const NOT_A_FEATURE: Record<string, string> = {
  'Manuscript AI Editor': 'logo tooltip', 'VC by Dawid Zyla — github.com/dzyla/manuscriptAI': 'credit link',
  'AI may make mistakes. Researcher is responsible for scientific correctness.': 'static notice', 'Text Zoom': 'readout between the zoom buttons',
  'Manuscript mode — journal-style agents': 'the other half of the mode toggle (row: switch between manuscript and grant mode)',
  'Remove image': 'chip on an attached chat image (row: attach an image to a chat message)',
  'Copy to My Templates for editing': 'inside the template picker, which moves whole (row: pick a grant template)',
  'Page limit (blank = none)': 'inside the template picker, which moves whole',
};

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
  it('lists every sidebar tab and every literal control title in the surfaces being restructured: nothing exists that no row reaches', () => {
    const steps = ENTRY_POINTS.flatMap(stepsOf);
    const coveredTitle = (t: string) => steps.some(st => st.startsWith('title:') && matches(t, st.slice(6)));
    const tabs = new Set([...source('src/components/Sidebar.tsx').matchAll(/activeTab === '([a-z]+)'/g)].map(m => m[1]).filter(t => t !== 'summary'));
    expect([...tabs].sort()).toEqual(['chat', 'history', 'outline', 'sources', 'style', 'suggestions']);
    // each tab is reached by a step that clicks it (a section step, or the rail that opens it)
    for (const t of ['chat', 'history', 'outline', 'style', 'suggestions']) expect(steps, `tab "${t}" has no row`).toContain(`section:${t}`);
    expect(steps, 'the sources tab has no row').toContain('rail:cite');
    for (const f of ['src/App.tsx', 'src/components/Editor.tsx', 'src/components/Sidebar.tsx', 'src/components/GrantPanel.tsx', 'src/components/VersionHistoryPopup.tsx']) {
      for (const m of source(f).matchAll(/\btitle="([^"]+)"/g)) {
        const t = m[1];
        if (t.startsWith('Editor width') || t in NOT_A_FEATURE) continue; // editorWidth is in EXCLUDED
        expect(coveredTitle(t), `${f}: control "${t}" has no row`).toBe(true);
      }
    }
    for (const t of ['title={`Align ${a}`}', 'title={`Set width to ${w}`}', 'title={darkMode ?']) {
      expect(source('src/components/Editor.tsx') + source('src/App.tsx'), t).toContain(t); // dynamic titles covered by rows align/resize a figure, dark mode
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
  ])('a control behind %s is not reachable', (_n, html) => { mk(html); expect(isShown(document.getElementById('t')!)).toBe(false); });
  it.each([
    ['a responsive reveal', '<div class="hidden sm:flex"><button id="t">x</button></div>'],
    ['a hover menu', '<div class="hidden group-hover:block"><button id="t">x</button></div>'],
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
