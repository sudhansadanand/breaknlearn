/** Magic-byte detection for the upload types the school import accepts (spec M03: MIME + magic check). */
export const MIME_PDF = "application/pdf";
export const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MIME_TEXT = "text/plain";
export const MIME_CSV = "text/csv";

export type SniffedKind = "pdf" | "docx" | "text";
export interface SniffResult {
  readonly kind: SniffedKind;
  /** `text/plain` for any text; whether it is CSV is decided by the caller from the declared type. */
  readonly mime: typeof MIME_PDF | typeof MIME_DOCX | typeof MIME_TEXT;
}

const startsWith = (bytes: Uint8Array, sig: readonly number[]) => sig.every((b, i) => bytes[i] === b);
const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04]; // PK\3\4

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number) => ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;

/** Entry names from the ZIP central directory (no decompression). Null when the archive is malformed. */
export function zipEntryNames(bytes: Uint8Array, maxEntries = 2000): string[] | null {
  const min = Math.max(0, bytes.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (count > maxEntries || cdOffset + cdSize > eocd) return null;
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8");
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) return null;
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    if (p + 46 + nameLen > bytes.length) return null;
    names.push(decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Valid UTF-8 (optional BOM) with no NUL and no C0 controls other than tab, LF, CR, FF. */
export function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const b of bytes) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return false;
    if (b === 0x7f) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
  return true;
}

export function sniffMime(bytes: Uint8Array): SniffResult | null {
  if (startsWith(bytes, PDF_SIG)) return { kind: "pdf", mime: MIME_PDF };
  if (startsWith(bytes, ZIP_LOCAL)) {
    const names = zipEntryNames(bytes);
    if (names?.includes("word/document.xml")) return { kind: "docx", mime: MIME_DOCX };
    return null;
  }
  if (isPlainText(bytes)) return { kind: "text", mime: MIME_TEXT };
  return null;
}
