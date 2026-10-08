import type { JSONContent } from '@tiptap/core';
import type { PreservationStore } from './docx/preserve/types';

export type AgentType = 'manager' | 'editor' | 'reviewer-2' | 'researcher' | 'literature-reviewer' | 'manuscript-ai' | 'citation-checker' | 'statistician' | 'consistency' | 'reporting';

export interface SemanticSearchResult {
  title: string;
  authors: string;
  journal: string;
  doi: string;
  abstract: string;
  year: number | null;
  score: number;
  source: string; // 'PubMed' | 'BioRxiv' | 'MedRxiv' | 'arXiv'
}

export interface ManuscriptSource {
  id: string;
  name: string;
  type: 'pdf' | 'bib' | 'api' | 'text';
  text: string;
  digest?: string;
  abstractText?: string;   // LLM-extracted abstract for pdf/text sources
  apiMeta?: SemanticSearchResult;
  queryText?: string;
}

/** Score entry from the PDF→database scoring agent */
export interface PdfMatchScore {
  index: number;   // 0-based index into the candidates array
  score: number;   // 0–100, or -1 if only heuristic order (no LLM score)
  reason: string;  // ≤15 words from LLM, empty if heuristic-only
}

export type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'local';

/** Editing mode: manuscripts get journal-style agents, grants get NIH-style agents */
export type DocumentMode = 'manuscript' | 'grant';

export type SuggestionSeverity = 'critical' | 'major' | 'minor' | 'style';

export type SuggestionCategory = 'grammar' | 'flow' | 'evidence' | 'impact' | 'clarity' | 'statistics' | 'citation' | 'structure' | 'style' | 'research';

export interface AISettings {
  provider: AIProvider;
  geminiApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiModel?: string;
  openaiModel?: string;
  anthropicModel?: string;
  localBaseUrl: string;
  localApiKey: string;
  localModel: string;
  localChunkSize?: number;  // 0 = no chunking (full manuscript), undefined/default = 2000 chars
  /** Local chunked analysis strategy. 'find-fix' (default): two-pass find-then-fix
   *  for small models. 'single': legacy one-shot per chunk. */
  pipelineMode?: 'find-fix' | 'single';
  /** Global override: run EVERY agent in advisory (flag-only) mode — no agent
   *  ever proposes replacement text. Default off; the data-dependent agents are
   *  advisory regardless of this flag. */
  adviceOnly?: boolean;
  /** Add a second "what did you miss?" recall pass to the find step. Default on. */
  recallPass?: boolean;
  customPrompts?: Partial<Record<AgentType, string>>;
  zotero?: ZoteroSettings;
}

export interface Suggestion {
  id: string;
  originalText: string;
  /** Replacement text for edit suggestions; empty string for advisory ones. */
  suggestedText: string;
  explanation: string;
  agent: AgentType;
  startIndex: number;
  endIndex: number;
  isApplied?: boolean;
  severity?: SuggestionSeverity;
  category?: SuggestionCategory;
  section?: string;
  /** 'edit' (default): a drop-in replacement the author can Accept. 'advisory':
   *  a flag with a recommendation — no replacement text, never auto-applied. */
  kind?: 'edit' | 'advisory';
  /** For advisory suggestions: the concrete action the author should take. */
  recommendation?: string;
}

export interface AttachedImage {
  id: string;
  name: string;
  base64: string;       // pure base64, no data URL prefix
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  dataUrl: string;      // full data URL for preview
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  agent?: AgentType;
  suggestions?: Suggestion[];
  images?: AttachedImage[];
}

export interface HistoryItem {
  id: string;
  timestamp: number;
  oldContent: string;
  newContent: string;
  originalText: string;
  suggestedText: string;
  suggestionId: string;
  agent: AgentType;
}

/** Named full-document snapshot for version history ("Time Machine") */
export interface VersionSnapshot {
  id: string;
  name: string;
  timestamp: number;
  title: string;
  content: string;
  description?: string;
  wordCount?: number;
}

/** Zotero API credentials for library sync */
export interface ZoteroSettings {
  apiKey: string;
  userId: string;
  groupId?: string;
  lastSynced?: number;
}

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

// ─── Dexie row types ──────────────────────────────────────────────────────────

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

export interface SourceRow extends ManuscriptSource {
  order: number;
}

export interface ChatHistoryRow {
  id: string;
  message: Message;
  order: number;
}

export interface SuggestionRow extends Suggestion {
  // id already on Suggestion
}

export interface HistoryItemRow extends HistoryItem {
  // id already on HistoryItem
}
