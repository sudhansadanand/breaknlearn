import { parseTocCsv } from "./csv";
import { extractDocxToc } from "./docx";
import { extractPdfToc } from "./pdf";
import { extractTocLines } from "./toc-lines";
import type { ExtractionResult, PlanScope } from "./types";

/** What the upload turned out to be after the MIME + magic check. */
export type SourceKind = "csv" | "text" | "docx" | "pdf";

/**
 * Runs the right extractor. Pure and synchronous: fine inline for small files; production should
 * run it from a queue worker (import_jobs) so request latency is bounded.
 */
export function extractChapters(kind: SourceKind, bytes: Uint8Array, scope: PlanScope): ExtractionResult {
  switch (kind) {
    case "csv":
      return parseTocCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes), scope);
    case "text":
      return extractTocLines(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    case "docx":
      return extractDocxToc(bytes);
    case "pdf":
      return extractPdfToc(bytes);
    default: {
      const never: never = kind;
      throw new Error(`unknown source kind ${String(never)}`);
    }
  }
}
