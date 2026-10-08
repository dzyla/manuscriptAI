import Dexie, { type Table } from 'dexie';
import type {
  DocumentRow,
  SourceRow,
  ChatHistoryRow,
  SuggestionRow,
  HistoryItemRow,
  VersionSnapshot,
  AssetRow,
  DocxPackageRow,
  BackupRow,
} from '../types';

export class ManuscriptDb extends Dexie {
  documents!: Table<DocumentRow>;
  sources!: Table<SourceRow>;
  chatHistory!: Table<ChatHistoryRow>;
  suggestions!: Table<SuggestionRow>;
  historyItems!: Table<HistoryItemRow>;
  versionSnapshots!: Table<VersionSnapshot>;
  grantTemplates!: Table<{ id: string; template: unknown; updatedAt: number }>;
  assets!: Table<AssetRow>;
  docxPackages!: Table<DocxPackageRow>;
  autosaveBackups!: Table<BackupRow>;

  constructor(name = 'ManuscriptAIEditor') {
    super(name);
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
    // v3: canonical JSON documents, content-addressed assets, original DOCX packages, autosave backups.
    // Document HTML→JSON migration is lazy (DocumentRepository.load), not done in this upgrade:
    // it needs async hashing, which cannot run inside an IndexedDB upgrade transaction.
    this.version(3).stores({
      assets: 'id, sha256',
      docxPackages: 'documentId',
      autosaveBackups: '++seq, documentId, savedAt',
    });
  }
}

export const db = new ManuscriptDb();
