import type { SubjectKey } from "@bnl/contracts";

export type Grade = 2 | 6;

/** A chapter candidate staged for human review. Never published by itself. */
export interface StagedChapter {
  readonly chapterNumber: string | null;
  /** Plain text, as found (formula-leading values are prefixed with `'`). Render escaped; never as HTML. */
  readonly title: string;
  readonly pageStart: number | null;
  /** 1-based order in the source. */
  readonly sortOrder: number;
  /** 0..1 confidence that this row is a real chapter with the right page. */
  readonly extractionConfidence: number;
  /** CSV record or text line number (1-based), for the review table. */
  readonly sourceRow: number | null;
  readonly flags: readonly ChapterFlag[];
}

export type ChapterFlag = "formula_escaped" | "page_out_of_order" | "no_number" | "no_page";

/** Row-level error (or warning when `severity` is "warning"); messages never echo submitted values. */
export interface RowError {
  readonly row: number | null;
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface ExtractionResult {
  /** `needs_manual_toc`: no usable text (scanned/encrypted PDF etc.); OCR is out of scope, ask for a pasted TOC. */
  readonly status: "ok" | "needs_manual_toc" | "invalid";
  readonly chapters: readonly StagedChapter[];
  readonly errors: readonly RowError[];
}

export interface PlanScope {
  readonly grade: Grade;
  readonly subjectKey: SubjectKey;
}

export const MAX_CHAPTERS = 500;
export const MAX_TITLE_CHARS = 200;
