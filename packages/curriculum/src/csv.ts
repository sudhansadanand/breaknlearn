import { escapeFormula, hasControlChars, isFormulaLike, looksLikeMarkup, normalizeSpace } from "./text-safety";
import { subjectKeyFor } from "./subjects";
import { MAX_CHAPTERS, MAX_TITLE_CHARS, type ChapterFlag, type ExtractionResult, type PlanScope, type RowError, type StagedChapter } from "./types";

export class CsvSyntaxError extends Error {
  override readonly name = "CsvSyntaxError";
  constructor(
    readonly record: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * RFC 4180 parser: quoted fields with "" escapes and embedded CR/LF, CRLF or LF record separators,
 * optional UTF-8 BOM. Returns records (arrays of raw field strings). Throws CsvSyntaxError.
 */
export function parseCsv(text: string, maxRecords = MAX_CHAPTERS + 1): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let i = 0;
  let quoted = false;
  let fieldStarted = false;
  const endRecord = () => {
    record.push(field);
    // Skip completely empty lines (a single empty field).
    if (!(record.length === 1 && record[0] === "" && !fieldStarted)) records.push(record);
    if (records.length > maxRecords) throw new CsvSyntaxError(records.length, "Too many rows");
    record = [];
    field = "";
    fieldStarted = false;
  };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = s[i];
        if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") {
          throw new CsvSyntaxError(records.length + 1, "Unexpected character after closing quote");
        }
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (field !== "") throw new CsvSyntaxError(records.length + 1, "Quote inside an unquoted field");
      quoted = true;
      fieldStarted = true;
      i++;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      fieldStarted = true;
      i++;
    } else if (ch === "\r" || ch === "\n") {
      endRecord();
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      fieldStarted = true;
      i++;
    }
  }
  if (quoted) throw new CsvSyntaxError(records.length + 1, "Unterminated quoted field");
  if (field !== "" || record.length > 0 || fieldStarted) endRecord();
  return records;
}

export const TOC_CSV_COLUMNS = ["chapter_no", "title", "page_start", "grade", "subject"] as const;
type Column = (typeof TOC_CSV_COLUMNS)[number];

const err = (row: number | null, code: string, message: string): RowError => ({ row, code, message, severity: "error" });
const warn = (row: number | null, code: string, message: string): RowError => ({ row, code, message, severity: "warning" });

/**
 * Parses a school TOC CSV with header `chapter_no,title,page_start,grade,subject` (any column order).
 * Valid rows become staged chapters; invalid rows are reported by record number (header = row 1) and skipped.
 * File-level problems (syntax, header, > 500 rows) stage nothing (`invalid`).
 */
export function parseTocCsv(text: string, scope: PlanScope): ExtractionResult {
  let records: string[][];
  try {
    records = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvSyntaxError) {
      const tooMany = e.message === "Too many rows";
      return {
        status: "invalid",
        chapters: [],
        errors: [tooMany ? err(null, "too_many_rows", `At most ${MAX_CHAPTERS} chapter rows are allowed`) : err(e.record, "csv_syntax", e.message)],
      };
    }
    throw e;
  }
  const [header, ...rows] = records;
  if (!header) return { status: "invalid", chapters: [], errors: [err(null, "empty_file", "The CSV file is empty")] };
  const names = header.map((h) => h.trim().toLowerCase());
  const index = {} as Record<Column, number>;
  const missing: string[] = [];
  for (const col of TOC_CSV_COLUMNS) {
    const at = names.indexOf(col);
    if (at < 0) missing.push(col);
    index[col] = at;
  }
  const unknown = names.filter((n) => !(TOC_CSV_COLUMNS as readonly string[]).includes(n));
  if (missing.length || unknown.length || new Set(names).size !== names.length) {
    return {
      status: "invalid",
      chapters: [],
      errors: [err(1, "bad_header", `Header must be exactly: ${TOC_CSV_COLUMNS.join(",")}`)],
    };
  }
  if (rows.length === 0) return { status: "invalid", chapters: [], errors: [err(null, "no_rows", "The CSV has a header but no chapter rows")] };

  const chapters: StagedChapter[] = [];
  const errors: RowError[] = [];
  let lastPage = 0;
  rows.forEach((cells, i) => {
    const row = i + 2;
    if (cells.length !== header.length) {
      errors.push(err(row, "column_count", `Expected ${header.length} columns`));
      return;
    }
    const cell = (c: Column) => cells[index[c]] ?? "";
    const flags: ChapterFlag[] = [];
    const rowErrors: RowError[] = [];

    const rawTitle = cell("title");
    const title = normalizeSpace(rawTitle);
    if (!title) rowErrors.push(err(row, "title_required", "Title is required"));
    else if (title.length > MAX_TITLE_CHARS) rowErrors.push(err(row, "title_too_long", `Title must be at most ${MAX_TITLE_CHARS} characters`));
    else if (looksLikeMarkup(title)) rowErrors.push(err(row, "markup_not_allowed", "Title must be plain text (HTML is not allowed)"));
    else if (hasControlChars(rawTitle.replace(/[\r\n\t]/g, " "))) rowErrors.push(err(row, "control_characters", "Title contains control characters"));

    const rawNo = normalizeSpace(cell("chapter_no"));
    let chapterNumber: string | null = null;
    if (rawNo) {
      if (isFormulaLike(rawNo) || !/^[A-Za-z0-9.]{1,20}$/.test(rawNo)) rowErrors.push(err(row, "bad_chapter_no", "chapter_no must be up to 20 letters, digits or dots"));
      else chapterNumber = rawNo;
    }

    const rawPage = cell("page_start").trim();
    let pageStart: number | null = null;
    if (rawPage) {
      if (!/^[0-9]{1,4}$/.test(rawPage) || Number(rawPage) < 1) rowErrors.push(err(row, "bad_page_start", "page_start must be a whole number from 1 to 9999"));
      else pageStart = Number(rawPage);
    }

    const rawGrade = cell("grade").trim();
    if (rawGrade !== "2" && rawGrade !== "6") rowErrors.push(err(row, "bad_grade", "grade must be 2 or 6"));
    else if (Number(rawGrade) !== scope.grade) rowErrors.push(err(row, "grade_mismatch", "grade does not match the school plan"));
    else {
      const key = subjectKeyFor(scope.grade, cell("subject"));
      if (!key) rowErrors.push(err(row, "bad_subject", "subject is not a subject of this grade"));
      else if (key !== scope.subjectKey) rowErrors.push(err(row, "subject_mismatch", "subject does not match the school plan"));
    }

    if (rowErrors.length) {
      errors.push(...rowErrors);
      return;
    }
    if (chapters.length >= MAX_CHAPTERS) {
      errors.push(err(row, "too_many_rows", `At most ${MAX_CHAPTERS} chapter rows are allowed`));
      return;
    }
    let storedTitle = title;
    if (isFormulaLike(title)) {
      storedTitle = escapeFormula(title);
      flags.push("formula_escaped");
      errors.push(warn(row, "formula_escaped", "Title began with = + - or @ and was stored as text"));
    }
    let confidence = 1;
    if (pageStart === null) flags.push("no_page");
    else if (pageStart < lastPage) {
      flags.push("page_out_of_order");
      confidence = 0.8;
      errors.push(warn(row, "page_out_of_order", "page_start is lower than the previous chapter's"));
    }
    if (pageStart !== null) lastPage = Math.max(lastPage, pageStart);
    if (chapterNumber === null) flags.push("no_number");
    chapters.push({
      chapterNumber,
      title: storedTitle,
      pageStart,
      sortOrder: chapters.length + 1,
      extractionConfidence: confidence,
      sourceRow: row,
      flags,
    });
  });
  return { status: chapters.length ? "ok" : "invalid", chapters, errors };
}
