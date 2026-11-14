/** Builds small synthetic PDFs for tests (no external fixtures, no copyrighted content). */
import { zlibSync } from "fflate";

const enc = new TextEncoder();
const latin1Bytes = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));

export interface PdfObj {
  readonly num: number;
  /** Object body (dictionary or other value), without `obj`/`endobj`. */
  readonly body: string;
  /** Raw stream bytes; `/Length` is added automatically. */
  readonly stream?: Uint8Array;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function buildPdf(objects: PdfObj[], trailer: string): Uint8Array {
  const parts: Uint8Array[] = [latin1Bytes("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let offset = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  for (const o of objects) {
    offsets[o.num] = offset;
    const chunk = o.stream
      ? concat([latin1Bytes(`${o.num} 0 obj\n${o.body.replace(/>>\s*$/, ` /Length ${o.stream.length} >>`)}\nstream\n`), o.stream, latin1Bytes("\nendstream\nendobj\n")])
      : latin1Bytes(`${o.num} 0 obj\n${o.body}\nendobj\n`);
    parts.push(chunk);
    offset += chunk.length;
  }
  const max = Math.max(...objects.map((o) => o.num));
  let xref = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++) xref += offsets[i] === undefined ? "0000000000 65535 f \n" : `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  parts.push(latin1Bytes(`${xref}trailer\n${trailer}\nstartxref\n${offset}\n%%EOF\n`));
  return concat(parts);
}

export const flate = (s: string | Uint8Array) => zlibSync(typeof s === "string" ? latin1Bytes(s) : s);
export const utf8 = (s: string) => enc.encode(s);

/** Escapes a JS string as a PDF literal string (ASCII only). */
export const lit = (s: string) => `(${s.replace(/([\\()])/g, "\\$1")})`;

/** Hex of UTF-16BE code units. */
export function utf16Hex(s: string): string {
  let h = "";
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0;
    h += cp.toString(16).padStart(4, "0");
  }
  return h.toUpperCase();
}
