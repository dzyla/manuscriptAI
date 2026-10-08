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
  PreservationRow,
  BackupRow,
  BackupPartsRow,
  ImportReportRow,
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
  preservationStores!: Table<PreservationRow>;
  importBackupParts!: Table<BackupPartsRow>;
  importReports!: Table<ImportReportRow>;

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
    // v4: the mutable preservation map leaves docxPackages, so saves never rewrite the original .docx bytes.
    // The upgrade moves any existing `preservation` field across (only Dexie operations inside the transaction).
    this.version(4)
      .stores({ preservationStores: 'documentId' })
      .upgrade(async tx => {
        const packages = tx.table('docxPackages');
        const stores = tx.table('preservationStores');
        const rows = (await packages.toArray()) as Array<Record<string, unknown> & { documentId: string }>;
        for (const row of rows) {
          if (!('preservation' in row)) continue;
          const { preservation, ...rest } = row;
          if (preservation && !(await stores.get(row.documentId))) {
            await stores.put({ documentId: row.documentId, store: preservation, updatedAt: Date.now() });
          }
          await packages.put(rest);
        }
      });
    // v5: the package and preservation map of a backed-up document live in their own table (keyed by the backup's seq), so scanning the
    // backup ring on every save does not deserialise packages.
    this.version(5).stores({ importBackupParts: 'seq' });
    // v6: the import report (what the import said it kept but does not show) is stored with the document it describes.
    this.version(6).stores({ importReports: 'documentId' });
  }
}

export const db = new ManuscriptDb();
