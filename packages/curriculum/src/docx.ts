import { Unzip, UnzipInflate } from "fflate";
import { extractTocLines } from "./toc-lines";
import type { ExtractionResult } from "./types";

/** Uncompressed size cap for word/document.xml (zip-bomb guard). */
export const MAX_DOCX_XML_BYTES = 16 * 1024 * 1024;

export class DocxError extends Error {
  override readonly name = "DocxError";
  constructor(
    readonly code: "not_docx" | "too_large" | "corrupt",
    message: string,
  ) {
    super(message);
  }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]+);/g, (m, ent: string) => {
    if (ent.startsWith("#x")) return safeCodePoint(parseInt(ent.slice(2), 16)) ?? m;
    if (ent.startsWith("#")) return safeCodePoint(parseInt(ent.slice(1), 10)) ?? m;
    return ENTITIES[ent] ?? m;
  });
}

function safeCodePoint(n: number): string | null {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : null;
}

/**
 * Streams one entry out of a zip, counting inflated bytes as they are produced so a zip bomb
 * (or a lying size header) is stopped at `maxBytes` instead of being fully inflated.
 */
export function readZipEntry(bytes: Uint8Array, name: string, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let found = false;
  let done = false;
  let failure: DocxError | null = null;
  const unzip = new Unzip((file) => {
    if (file.name !== name || found) return;
    found = true;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = new DocxError("corrupt", "The DOCX file could not be read");
        return;
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        failure = new DocxError("too_large", "The document is too large to read");
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) done = true;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch (e) {
    if (e instanceof Error) throw new DocxError("corrupt", "The DOCX file could not be read");
    throw e;
  }
  if (failure) throw failure;
  if (!found) throw new DocxError("not_docx", `The file has no ${name}`);
  if (!done) throw new DocxError("corrupt", "The DOCX file could not be read");
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Paragraph texts of word/document.xml, in order (runs joined; tabs kept; breaks become spaces). */
export function docxParagraphs(bytes: Uint8Array): string[] {
  const xmlBytes = readZipEntry(bytes, "word/document.xml", MAX_DOCX_XML_BYTES);
  const xml = new TextDecoder("utf-8").decode(xmlBytes);
  const body = xml.replace(/<w:(?:del|instrText|delText)\b[^>]*>[\s\S]*?<\/w:(?:del|instrText|delText)>/g, "");
  const paragraphs: string[] = [];
  for (const p of body.split(/<\/w:p>/)) {
    let text = "";
    const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = token.exec(p)) !== null) {
      if (m[1] !== undefined) text += decodeXmlText(m[1]);
      else if (m[0].startsWith("<w:tab")) text += "\t";
      else text += " ";
    }
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs;
}

export function extractDocxToc(bytes: Uint8Array): ExtractionResult {
  let paragraphs: string[];
  try {
    paragraphs = docxParagraphs(bytes);
  } catch (e) {
    if (e instanceof DocxError) return { status: "invalid", chapters: [], errors: [{ row: null, code: `docx_${e.code}`, message: e.message, severity: "error" }] };
    throw e;
  }
  if (paragraphs.length === 0) {
    return { status: "needs_manual_toc", chapters: [], errors: [{ row: null, code: "needs_manual_toc", message: "No text was found in the document; paste the table of contents instead", severity: "error" }] };
  }
  return extractTocLines(paragraphs.join("\n"));
}
