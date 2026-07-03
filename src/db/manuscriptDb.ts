import Dexie, { type Table } from 'dexie';
import type {
  DocumentRow,
  SourceRow,
  ChatHistoryRow,
  SuggestionRow,
  HistoryItemRow,
  VersionSnapshot,
} from '../types';

class ManuscriptDb extends Dexie {
  documents!: Table<DocumentRow>;
  sources!: Table<SourceRow>;
  chatHistory!: Table<ChatHistoryRow>;
  suggestions!: Table<SuggestionRow>;
  historyItems!: Table<HistoryItemRow>;
  versionSnapshots!: Table<VersionSnapshot>;
  grantTemplates!: Table<{ id: string; template: unknown; updatedAt: number }>;

  constructor() {
    super('ManuscriptAIEditor');
    this.version(1).stores({
      documents: 'id',
      sources: 'id, order',
      chatHistory: 'id, order',
      suggestions: 'id',
      historyItems: 'id, timestamp',
      versionSnapshots: 'id, timestamp',
    });
    // v2: user-defined / AI-generated grant templates
    this.version(2).stores({
      grantTemplates: 'id, updatedAt',
    });
  }
}

export const db = new ManuscriptDb();
