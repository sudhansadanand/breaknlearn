/**
 * Text hygiene for imported titles. Titles are stored and rendered as plain text; markup is rejected
 * (SEC-008) and spreadsheet formula prefixes are neutralised (CSV injection) so a later CSV export is safe.
 */

/** Anything that looks like an HTML/XML tag, comment, or entity-encoded tag. */
const MARKUP = /<\s*[a-zA-Z!/?]|&lt;\s*[a-zA-Z!/?]|javascript\s*:/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

export function looksLikeMarkup(s: string): boolean {
  return MARKUP.test(s);
}

export function hasControlChars(s: string): boolean {
  return CONTROL.test(s);
}

/** OWASP CSV injection: cells starting with = + - @ (or tab/CR) are interpreted as formulas. */
export function isFormulaLike(s: string): boolean {
  return /^[=+\-@\t\r]/.test(s);
}

/** Prefixes a formula-like value with an apostrophe so it is stored and exported as text. */
export function escapeFormula(s: string): string {
  return isFormulaLike(s) ? `'${s}` : s;
}

/** Collapses internal whitespace runs and trims. */
export function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
