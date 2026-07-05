/**
 * Review-note markers.
 *
 * Advisory suggestions never rewrite the manuscript. When an author acts on one,
 * we instead insert a visible inline reminder next to the flagged span so the note
 * travels with the text while they fix it by hand. The marker uses CJK angle
 * brackets plus a warning sign — a sequence that never occurs in natural
 * scientific prose, so it is trivial to locate, strip, and export-filter.
 */
export const REVIEW_NOTE_OPEN = '《⚠ ';
export const REVIEW_NOTE_CLOSE = '》';

/** Matches a whole review note (with any leading whitespace) for stripping. */
export const REVIEW_NOTE_RE = /\s*《⚠[^》]*》/g;

/** Build the inline reminder inserted after a flagged span. Keeps it short. */
export function buildReviewNote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return ` ${REVIEW_NOTE_OPEN}${clean}${REVIEW_NOTE_CLOSE}`;
}

/** Remove every review note from a string (used at export boundaries). */
export function stripReviewNotes(text: string): string {
  return text.replace(REVIEW_NOTE_RE, '');
}
