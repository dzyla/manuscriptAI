/**
 * Plain-text and Markdown files as editor HTML. Deliberately small: blank-line paragraphs, and for Markdown `#`-headings and `-`/`*`
 * bullet lists. Inline Markdown (emphasis, links, code) is left as typed rather than half-converted; a Word document is the format
 * for anything richer.
 */
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function textToHtml(text: string, markdown: boolean): string {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const html: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (markdown) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
      if (heading && lines.length === 1) {
        const level = Math.min(heading[1].length, 3);
        html.push(`<h${level}>${escapeHtml(heading[2].trim())}</h${level}>`);
        continue;
      }
      if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
        html.push(`<ul>${lines.map(l => `<li><p>${escapeHtml(l.replace(/^\s*[-*]\s+/, ''))}</p></li>`).join('')}</ul>`);
        continue;
      }
    }
    html.push(`<p>${lines.map(l => escapeHtml(l.trim())).join(' ')}</p>`);
  }
  return html.length ? html.join('') : '<p></p>';
}
