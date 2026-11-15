import { escapeFormula, hasControlChars, isFormulaLike, looksLikeMarkup, normalizeSpace } from "./text-safety";
import { MAX_CHAPTERS, MAX_TITLE_CHARS, type ChapterFlag, type ExtractionResult, type RowError, type StagedChapter } from "./types";

const HEADINGS = /^(?:table\s+of\s+)?contents?$|^index$|^(?:chapter|lesson|unit|s\.?\s*no\.?|sr\.?\s*no\.?)?\s*(?:name|title|topic)?\s*(?:page(?:\s*no\.?)?|pg\.?)$/i;
const PREFIX_WORD = /^(?:chapter|chap\.?|ch\.?|unit|lesson|lsn\.?)\s*[-#:]?\s*([0-9]{1,3}|[ivxlc]{1,7})\b\s*[.:)\-–—]*\s*/i;
const PREFIX_NUM = /^([0-9]{1,3}(?:\.[0-9]{1,2})?)\s*(?:[.:)\-–—]+\s*|\s+(?=\S))/;
/** Trailing page number separated by dot leaders, tabs, several spaces, a dash, or one space after a letter. */
const TRAILING_PAGE = /(?:\s*(?:[.·…_]{2,}|…)\s*|\t+\s*|\s{2,}|\s+[-–—]\s+|\s+(?:p\.?|pg\.?|page)\s*|\s+)([0-9]{1,4})$/i;
const LEADERS = /[\s.·…_\-–—]+$/;

const warn = (row: number, code: string, message: string): RowError => ({ row, code, message, severity: "warning" });
const err = (row: number | null, code: string, message: string): RowError => ({ row, code, message, severity: "error" });

interface Candidate {
  line: number;
  chapterNumber: string | null;
  title: string;
  pageStart: number | null;
  leaders: boolean;
}

function parseLine(raw: string, line: number): Candidate | null {
  // Tabs stay significant for page detection; everything else is whitespace-normalised.
  const tabbed = raw.trim();
  let s = normalizeSpace(raw);
  if (!s || HEADINGS.test(s)) return null;
  let pageStart: number | null = null;
  let leaders = false;
  const pageMatch = TRAILING_PAGE.exec(tabbed.replace(/[ \u00a0]+$/, ""));
  let body = tabbed;
  if (pageMatch && pageMatch.index > 0) {
    const n = Number(pageMatch[1]);
    const before = tabbed.slice(0, pageMatch.index);
    // A bare trailing number after one space only counts when the line also has a chapter prefix
    // (otherwise "Numbers up to 100" would lose its 100).
    const separator = pageMatch[0].slice(0, pageMatch[0].length - (pageMatch[1] ?? "").length);
    const strongSep = /[.·…_]{2}|…|\t|\s{2,}|[-–—]|p/i.test(separator);
    if (n >= 1 && (strongSep || PREFIX_WORD.test(before.trim()) || PREFIX_NUM.test(before.trim()))) {
      pageStart = n;
      leaders = /[.·…_]{2}|…/.test(separator);
      body = before;
    }
  }
  s = normalizeSpace(body).replace(LEADERS, "");
  let chapterNumber: string | null = null;
  const word = PREFIX_WORD.exec(s);
  if (word) {
    chapterNumber = word[1] ?? null;
    s = s.slice(word[0].length);
  } else {
    const num = PREFIX_NUM.exec(s);
    if (num && /[A-Za-z\u0080-￿]/.test(s.slice(num[0].length))) {
      chapterNumber = num[1] ?? null;
      s = s.slice(num[0].length);
    }
  }
  const title = normalizeSpace(s.replace(/^[.:)\-–—\s]+/, "").replace(LEADERS, ""));
  if (!/[\p{L}]/u.test(title)) return null;
  return { line, chapterNumber, title, pageStart, leaders };
}

/**
 * Extracts chapter candidates from table-of-contents text (pasted, or from PDF/DOCX text), e.g.
 * "3. Shapes and Patterns ........ 24" or "Chapter 4 – Measurement 31". Lines with neither a
 * chapter number nor a page are treated as headings and skipped, unless no line has either
 * (a plain list of titles), in which case every line is a low-confidence chapter.
 */
export function extractTocLines(text: string): ExtractionResult {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
  const candidates: Candidate[] = [];
  lines.forEach((raw, i) => {
    const c = parseLine(raw, i + 1);
    if (c) candidates.push(c);
  });
  const structured = candidates.some((c) => c.chapterNumber !== null || c.pageStart !== null);
  const chosen = structured ? candidates.filter((c) => c.chapterNumber !== null || c.pageStart !== null) : candidates;

  const chapters: StagedChapter[] = [];
  const errors: RowError[] = [];
  let lastPage = 0;
  for (const c of chosen) {
    if (looksLikeMarkup(c.title)) {
      errors.push(err(c.line, "markup_not_allowed", "Line skipped: titles must be plain text (HTML is not allowed)"));
      continue;
    }
    if (hasControlChars(c.title)) {
      errors.push(err(c.line, "control_characters", "Line skipped: it contains control characters"));
      continue;
    }
    if (c.title.length > MAX_TITLE_CHARS) {
      errors.push(err(c.line, "title_too_long", `Line skipped: titles must be at most ${MAX_TITLE_CHARS} characters`));
      continue;
    }
    if (chapters.length >= MAX_CHAPTERS) {
      errors.push(err(c.line, "too_many_rows", `At most ${MAX_CHAPTERS} chapters are allowed; the rest were skipped`));
      break;
    }
    const flags: ChapterFlag[] = [];
    let confidence = structured ? 0.5 : 0.35;
    if (c.chapterNumber !== null) confidence += 0.25;
    else flags.push("no_number");
    if (c.pageStart !== null) {
      confidence += 0.15;
      if (c.leaders) confidence += 0.05;
      if (c.pageStart < lastPage) {
        confidence -= 0.25;
        flags.push("page_out_of_order");
        errors.push(warn(c.line, "page_out_of_order", "Page number is lower than the previous chapter's"));
      }
      lastPage = Math.max(lastPage, c.pageStart);
    } else flags.push("no_page");
    let title = c.title;
    if (isFormulaLike(title)) {
      title = escapeFormula(title);
      flags.push("formula_escaped");
      errors.push(warn(c.line, "formula_escaped", "Title began with = + - or @ and was stored as text"));
    }
    chapters.push({
      chapterNumber: c.chapterNumber,
      title,
      pageStart: c.pageStart,
      sortOrder: chapters.length + 1,
      extractionConfidence: Math.round(Math.min(0.95, Math.max(0.05, confidence)) * 1000) / 1000,
      sourceRow: c.line,
      flags,
    });
  }
  if (chapters.length === 0) {
    return { status: "invalid", chapters, errors: [...errors, err(null, "no_chapters_found", "No chapter lines were found in the table of contents")] };
  }
  return { status: "ok", chapters, errors };
}
