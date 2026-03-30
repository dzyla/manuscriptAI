import type { ManuscriptSource, SemanticSearchResult } from '../types';

export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType: string;
}

export interface ZoteroItemData {
  title: string;
  abstractNote: string;
  publicationTitle: string;
  DOI: string;
  ISBN: string;
  year?: string;
  date?: string;
  creators: ZoteroCreator[];
  itemType: string;
  url?: string;
}

export interface ZoteroItem {
  key: string;
  data: ZoteroItemData;
}

function zoteroItemToSource(item: ZoteroItem): ManuscriptSource {
  const d = item.data;
  const authors = d.creators
    .filter(c => c.creatorType === 'author')
    .map(c => c.lastName
      ? `${c.lastName}, ${(c.firstName ?? '').charAt(0)}.`
      : (c.name ?? ''))
    .join('; ');

  const yearStr = d.year ?? d.date?.slice(0, 4) ?? '';
  const year = yearStr ? parseInt(yearStr, 10) : null;
  const abstract = d.abstractNote ?? '';

  const meta: SemanticSearchResult = {
    title: d.title || 'Untitled',
    authors,
    journal: d.publicationTitle || '',
    doi: d.DOI || '',
    abstract,
    year,
    score: 1.0,
    source: 'Zotero',
  };

  return {
    id: `zotero-${item.key}`,
    name: d.title || 'Untitled',
    type: 'api',
    text: abstract,
    digest: abstract.slice(0, 500),
    apiMeta: meta,
  };
}

/**
 * Fetch items from the Zotero API using an API key.
 * Returns up to 500 journal article / preprint items converted to ManuscriptSource.
 *
 * Get your API key at: https://www.zotero.org/settings/keys
 * Get your user ID at: https://www.zotero.org/settings/keys (shown above the key list)
 */
export async function fetchZoteroLibrary(
  userId: string,
  apiKey: string,
  groupId?: string
): Promise<ManuscriptSource[]> {
  const baseUrl = groupId
    ? `https://api.zotero.org/groups/${groupId}/items`
    : `https://api.zotero.org/users/${userId}/items`;

  const headers: Record<string, string> = {
    'Zotero-API-Key': apiKey,
    'Zotero-API-Version': '3',
  };

  const allItems: ZoteroItem[] = [];
  let start = 0;
  const limit = 100;
  const maxItems = 500;

  while (allItems.length < maxItems) {
    const url = `${baseUrl}?format=json&start=${start}&limit=${limit}`;
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Zotero API error ${resp.status}: ${body}`);
    }

    const items: ZoteroItem[] = await resp.json();
    allItems.push(...items);

    if (items.length < limit) break;
    start += limit;
  }

  // Filter to item types that are useful as manuscript sources
  const useful = new Set(['journalArticle', 'preprint', 'conferencePaper', 'book', 'bookSection', 'report', 'thesis']);
  return allItems
    .filter(item => useful.has(item.data.itemType))
    .map(zoteroItemToSource);
}
