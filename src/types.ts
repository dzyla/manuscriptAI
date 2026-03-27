export type AgentType = 'manager' | 'editor' | 'reviewer-2' | 'researcher' | 'literature-reviewer' | 'manuscript-ai' | 'citation-checker';

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
  apiMeta?: SemanticSearchResult;
  queryText?: string;
}

export type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'local';

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
  customPrompts?: Partial<Record<AgentType, string>>;
}

export interface Suggestion {
  id: string;
  originalText: string;
  suggestedText: string;
  explanation: string;
  agent: AgentType;
  startIndex: number;
  endIndex: number;
  isApplied?: boolean;
  severity?: SuggestionSeverity;
  category?: SuggestionCategory;
  section?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  agent?: AgentType;
  suggestions?: Suggestion[];
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
