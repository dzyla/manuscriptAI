import { useState } from 'react';
import type { AgentType } from '../../types';
import type { SelectionInfo } from '../editor/selectionKind';
import type { ExportFormat } from '../../hooks/useExport';
import { revertLabel } from '../../services/importSafety';
import type { MenuItem, TopBarItems } from './TopBar';
import { SELECTION_PRESETS, type SelectionPreset } from './selectionPresets';
import { InstructForm, SynonymChips } from './aiPanels';

/** Everything the menus call. Each field is a handler the App already owns; the menus add no behaviour of their own beyond which items exist and when they are enabled. */
export interface MenuActions {
  selection: SelectionInfo;
  busy: boolean;
  autocomplete: boolean;
  autocompleteLoading: boolean;
  darkMode: boolean;
  focusMode: boolean;
  zoom: number;
  agents: { id: AgentType; label: string }[];
  thesaurus: { word: string; synonyms: string[]; loading: boolean } | null;
  /** From the import flow: present only while there is something to show or restore. */
  storedReport: boolean;
  revertTarget: { title: string; savedAt: number } | null;
  // file
  onNew: () => void; onImport: () => void; onImportReport: () => void; onRevertImport: () => void; onSaveWorkspace: () => void; onExport: (f: ExportFormat) => void; onUndo: () => void; onRedo: () => void;
  // insert
  onInsertCitation: () => void; onInsertImage: () => void; onInsertFigureLabel: () => void; onInsertTable: (anchor: DOMRect) => void;
  // ai
  onAnalyze: () => void; onAnalyzeAgent: (a: AgentType) => void; onSummary: () => void; onStop: () => void; onAnalyzeSection: () => void; onToggleAutocomplete: () => void;
  onPreset: (p: SelectionPreset) => void; onRewrite: () => void; onInstruct: (text: string, agent: AgentType) => void; onSynonyms: () => void; onPickSynonym: (s: string) => void; onVerify: () => void; onSimilar: () => void;
  // overflow
  onSettings: () => void; onPostDrafting: () => void; onShortcuts: () => void; onToggleDark: () => void; onToggleFocus: () => void; onZoomOut: () => void; onZoomIn: () => void;
}

/**
 * The four menus' contents. Which AI items need a selection is decided by the top bar (anything not marked `anywhere`); what else disables an item
 * (no section under the cursor, the wrong number of words) is decided here, with the reason as the tooltip.
 */
export function useTopBarItems(a: MenuActions): TopBarItems {
  const [instructOpen, setInstructOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const { words, section } = a.selection;

  const file: MenuItem[] = [
    { id: 'new', label: 'New manuscript', onSelect: a.onNew },
    { id: 'import', label: 'Load Document (.json, .docx, .md, .txt)', onSelect: a.onImport },
    ...(a.storedReport ? [{ id: 'import-report', label: 'Import report (what was kept but is not shown)', onSelect: a.onImportReport }] : []),
    ...(a.revertTarget ? [{ id: 'revert-import', label: revertLabel(a.revertTarget), hint: `Saved ${new Date(a.revertTarget.savedAt).toLocaleString()}`, onSelect: a.onRevertImport }] : []),
    { id: 'save-workspace', label: 'Save Workspace', hint: 'Ctrl+S', onSelect: a.onSaveWorkspace, separatorBefore: true },
    { id: 'export-md', label: 'Export Markdown', onSelect: () => a.onExport('md') },
    { id: 'export-docx', label: 'Export Word', onSelect: () => a.onExport('docx') },
    { id: 'export-tex', label: 'Export to LaTeX (.zip)', onSelect: () => a.onExport('tex') },
    { id: 'undo', label: 'Undo', hint: 'Ctrl+Z', onSelect: a.onUndo, separatorBefore: true },
    { id: 'redo', label: 'Redo', hint: 'Ctrl+Shift+Z', onSelect: a.onRedo },
  ];
  const insert: MenuItem[] = [
    { id: 'citation', label: 'Citation', hint: 'Same as typing @', onSelect: a.onInsertCitation },
    { id: 'figure', label: 'Figure / image…', onSelect: a.onInsertImage },
    { id: 'figure-label', label: 'Figure label (auto-numbered)', onSelect: a.onInsertFigureLabel },
    { id: 'table', label: 'Table…', onSelect: a.onInsertTable },
  ];
  const preset = (p: SelectionPreset): MenuItem => ({
    id: p.label.toLowerCase(), label: `${p.label} the selection`,
    hint: p.mode === 'transform' ? 'Creates an accept/reject suggestion' : 'Opens the answer in chat', onSelect: () => a.onPreset(p),
  });
  const ai: MenuItem[] = [
    { id: 'analyze', label: 'Analyze all', hint: 'Ctrl+Shift+A', anywhere: true, disabled: a.busy, onSelect: a.onAnalyze },
    { id: 'analyze-agent', label: 'Run a single agent', anywhere: true, disabled: a.busy, keepOpen: true, expanded: agentsOpen, onSelect: () => setAgentsOpen(o => !o),
      children: a.agents.map(g => ({ id: `agent-${g.id}`, testId: 'analyze-agent-one', label: g.label, anywhere: true, onSelect: () => a.onAnalyzeAgent(g.id) })) },
    { id: 'summary', label: 'Summary & gaps', hint: 'Generate a high-level manuscript review with strengths, weaknesses, and recommendations', anywhere: true, disabled: a.busy, onSelect: a.onSummary },
    ...(a.busy ? [{ id: 'stop', label: 'Stop', hint: 'Stop the running request', anywhere: true, danger: true, onSelect: a.onStop }] : []),
    { id: 'analyze-section', label: section ? `Analyze section: ${section}` : 'Analyze the section at the cursor', anywhere: true, disabled: !section || a.busy,
      disabledReason: section ? undefined : 'Place the cursor inside a section (under an H2 heading) first', hint: 'Reviews only this section', onSelect: a.onAnalyzeSection },
    { id: 'autocomplete', label: a.autocompleteLoading ? 'Autocomplete (thinking…)' : 'Autocomplete', hint: 'Tab accepts a suggestion while typing', anywhere: true, checked: a.autocomplete, keepOpen: true, onSelect: a.onToggleAutocomplete },
    { ...preset(SELECTION_PRESETS[0]), separatorBefore: true },
    ...SELECTION_PRESETS.slice(1).map(preset),
    { id: 'rewrite', label: 'Rewrite the selection', hint: 'Rewrite and get an accept/reject suggestion', onSelect: a.onRewrite },
    { id: 'instruct', label: 'Give the selection a custom instruction…', keepOpen: true, expanded: instructOpen, onSelect: () => setInstructOpen(o => !o),
      panel: <InstructForm onSend={(t, g) => { setInstructOpen(false); a.onInstruct(t, g); }} /> },
    { id: 'synonyms', label: 'Find synonyms for the selection', hint: 'Alternatives for one or two selected words', keepOpen: true, disabled: words < 1 || words > 2,
      disabledReason: 'Select one or two words to look up alternatives', expanded: !!a.thesaurus, onSelect: a.onSynonyms,
      panel: a.thesaurus ? <SynonymChips word={a.thesaurus.word} synonyms={a.thesaurus.synonyms} loading={a.thesaurus.loading} onPick={a.onPickSynonym} /> : null },
    { id: 'verify', label: 'Verify the selection against sources', hint: 'Check this claim against the uploaded PDF sources', onSelect: a.onVerify },
    { id: 'similar', label: 'Find manuscripts similar to the selection', hint: 'Search the literature for published papers like this passage', disabled: words <= 5,
      disabledReason: 'Select more than a few words (six or more) to search for similar manuscripts', onSelect: a.onSimilar },
  ];
  const overflow: MenuItem[] = [
    { id: 'settings', label: 'Settings (AI configuration)…', onSelect: a.onSettings },
    { id: 'post-drafting', label: 'Rebuttal & cover letter…', hint: 'Post-drafting assistant', onSelect: a.onPostDrafting },
    { id: 'shortcuts', label: 'Keyboard shortcuts', hint: 'Ctrl+?', onSelect: a.onShortcuts },
    { id: 'dark-mode', label: 'Dark mode', checked: a.darkMode, keepOpen: true, onSelect: a.onToggleDark, separatorBefore: true },
    { id: 'focus-mode', label: 'Focus mode', hint: 'Hide the rail and panels', checked: a.focusMode, onSelect: a.onToggleFocus },
    { id: 'zoom-out', label: `Zoom out (${a.zoom}%)`, keepOpen: true, disabled: a.zoom <= 50, onSelect: a.onZoomOut },
    { id: 'zoom-in', label: `Zoom in (${a.zoom}%)`, keepOpen: true, disabled: a.zoom >= 200, onSelect: a.onZoomIn },
  ];
  return { file, insert, ai, overflow };
}
