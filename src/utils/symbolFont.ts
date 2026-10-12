/**
 * Word writes Greek letters and symbols in the Symbol font as private-use code points (U+F06D is a Symbol-font
 * 'm', that is µ). They reach extracted text as characters nothing can match, so "5<U+F06D>g" never reads as a dose.
 * This module maps the ones that carry meaning in scientific text and is deliberately free of any review concerns,
 * so the DOCX reader can use it too.
 */

const SYMBOL_FONT: Record<string, string> = {
  '': 'α', '': 'β', '': 'γ', '': 'δ', '': 'ε', '': 'κ', '': 'λ',
  '': 'µ', '': 'π', '': 'σ', '': 'τ', '': 'ω', '': '°', '': '±',
  '': '≤', '': '≥', '': '×', '': '·', '': '→',
};

/**
 * Replace Symbol-font private-use code points with the characters they stand for. Any other character in
 * U+E000-U+F8FF has no meaning outside its font and is dropped.
 */
export function deSymbol(text: string): string {
  return text.replace(/[-]/g, ch => SYMBOL_FONT[ch] ?? '');
}
