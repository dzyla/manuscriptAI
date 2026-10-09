import type { DocFormat } from '../types';

/** Above this a limit is a typo, not a limit. */
export const MAX_PAGE_LIMIT = 999;

/** The author's page limit from a stored value, or null when it is unset or not a sane positive number (a corrupt file cannot invent one). */
export function readPageLimit(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_PAGE_LIMIT ? v : null;
}

export type PageLimitInput = { kind: 'unset' } | { kind: 'ok'; value: number } | { kind: 'bad' };

/** What the author typed into the limit field: blank unsets it; a positive number up to MAX_PAGE_LIMIT is kept (to two decimals); anything else is rejected. */
export function parsePageLimitInput(text: string): PageLimitInput {
  const t = text.trim();
  if (t === '') return { kind: 'unset' };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PAGE_LIMIT) return { kind: 'bad' };
  const value = Math.round(n * 100) / 100;
  return value > 0 ? { kind: 'ok', value } : { kind: 'bad' };
}

/** The format with its page limit set (or removed, for null). Every other field is untouched. */
export function withPageLimit(format: DocFormat, limit: number | null): DocFormat {
  const { pageLimitPages: _drop, ...rest } = format;
  return limit === null ? rest : { ...rest, pageLimitPages: limit };
}
