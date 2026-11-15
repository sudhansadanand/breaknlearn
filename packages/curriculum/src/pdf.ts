/**
 * Minimal, dependency-light PDF text extraction (pure TypeScript + fflate for FlateDecode).
 *
 * Scope: text-based PDFs (the kind a word processor or publisher exports). Supports classic
 * objects and compressed object streams, FlateDecode content streams, page-tree order, inherited
 * resources, simple fonts (WinAnsi/Standard, byte = character) and composite/simple fonts with a
 * ToUnicode CMap (bfchar/bfrange). Not supported: encryption, image-only (scanned) pages, LZW/
 * ASCII85/other filters, Type3 glyph names. Those return `needs_manual_toc`; OCR is out of scope.
 */
import { Unzlib } from "fflate";
import { extractTocLines } from "./toc-lines";
import type { ExtractionResult } from "./types";

export const MAX_PDF_INFLATED_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_PAGES = 60;

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------
export interface PdfRef {
  readonly kind: "ref";
  readonly num: number;
  readonly gen: number;
}
export interface PdfName {
  readonly kind: "name";
  readonly value: string;
}
export interface PdfString {
  readonly kind: "string";
  readonly bytes: Uint8Array;
}
export type PdfDict = Map<string, PdfValue>;
export type PdfValue = number | boolean | null | PdfRef | PdfName | PdfString | PdfValue[] | PdfDict | { readonly kind: "op"; readonly value: string };

interface PdfObject {
  readonly value: PdfValue;
  readonly stream: Uint8Array | null;
}

class PdfError extends Error {
  override readonly name = "PdfError";
}

const isDelim = (c: number) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

/** Byte-level tokenizer/parser shared by object bodies and content streams. */
class Lexer {
  pos: number;
  constructor(
    readonly b: Uint8Array,
    start = 0,
    readonly end = b.length,
  ) {
    this.pos = start;
  }

  skipWs(): void {
    while (this.pos < this.end) {
      const c = this.b[this.pos] ?? 0;
      if (isWs(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.end && this.b[this.pos] !== 0x0a && this.b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  private regular(): string {
    const start = this.pos;
    while (this.pos < this.end) {
      const c = this.b[this.pos] ?? 0;
      if (isWs(c) || isDelim(c)) break;
      this.pos++;
    }
    return latin1(this.b.subarray(start, this.pos));
  }

  private literalString(): PdfString {
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      const c = this.b[this.pos++] ?? 0;
      if (c === 0x5c) {
        const n = this.b[this.pos++] ?? 0;
        const map: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (map[n] !== undefined) out.push(map[n]);
        else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let k = 0; k < 2; k++) {
            const d = this.b[this.pos] ?? 0;
            if (d < 0x30 || d > 0x37) break;
            v = v * 8 + (d - 0x30);
            this.pos++;
          }
          out.push(v & 0xff);
        } else if (n === 0x0d) {
          if (this.b[this.pos] === 0x0a) this.pos++;
        } else if (n !== 0x0a) out.push(n);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return { kind: "string", bytes: Uint8Array.from(out) };
  }

  private hexString(): PdfString {
    this.pos++; // <
    let hex = "";
    while (this.pos < this.end && this.b[this.pos] !== 0x3e) {
      const c = this.b[this.pos++] ?? 0;
      if (!isWs(c)) hex += String.fromCharCode(c);
    }
    this.pos++; // >
    if (hex.length % 2) hex += "0";
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    return { kind: "string", bytes: out };
  }

  /** Reads one value. Operators (bare keywords) come back as `{kind:"op"}`. Null at end of input. */
  value(depth = 0): PdfValue | undefined {
    if (depth > 64) throw new PdfError("nesting too deep");
    this.skipWs();
    if (this.pos >= this.end) return undefined;
    const c = this.b[this.pos] ?? 0;
    if (c === 0x28) return this.literalString();
    if (c === 0x3c) {
      if (this.b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        const dict: PdfDict = new Map();
        for (;;) {
          this.skipWs();
          if (this.pos >= this.end) return dict;
          if (this.b[this.pos] === 0x3e && this.b[this.pos + 1] === 0x3e) {
            this.pos += 2;
            return dict;
          }
          const k = this.value(depth + 1);
          if (k === undefined) return dict;
          if (typeof k !== "object" || k === null || !("kind" in k) || k.kind !== "name") continue;
          const v = this.value(depth + 1);
          if (v === undefined) return dict;
          dict.set(k.value, v);
        }
      }
      return this.hexString();
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= this.end) return arr;
        if (this.b[this.pos] === 0x5d) {
          this.pos++;
          return arr;
        }
        const v = this.value(depth + 1);
        if (v === undefined) return arr;
        arr.push(v);
      }
    }
    if (c === 0x2f) {
      this.pos++;
      const raw = this.regular();
      return { kind: "name", value: raw.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      this.pos++;
      return { kind: "op", value: String.fromCharCode(c) };
    }
    const word = this.regular();
    if (word === "") {
      this.pos++;
      return { kind: "op", value: "" };
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      const n = Number(word);
      // Indirect reference "N G R"?
      if (/^\d+$/.test(word)) {
        const save = this.pos;
        this.skipWs();
        const gen = this.regular();
        if (/^\d+$/.test(gen)) {
          this.skipWs();
          if (this.b[this.pos] === 0x52 && (this.pos + 1 >= this.end || isWs(this.b[this.pos + 1] ?? 0) || isDelim(this.b[this.pos + 1] ?? 0))) {
            this.pos++;
            return { kind: "ref", num: n, gen: Number(gen) };
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { kind: "op", value: word };
  }
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

const isName = (v: PdfValue | undefined, name?: string): v is PdfName =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && v.kind === "name" && (name === undefined || v.value === name);
const isRef = (v: PdfValue | undefined): v is PdfRef => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && v.kind === "ref";
const isDict = (v: PdfValue | undefined): v is PdfDict => v instanceof Map;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
class Inflater {
  total = 0;
  constructor(private readonly max: number) {}

  inflate(data: Uint8Array): Uint8Array | null {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let over = false;
    const z = new Unzlib((chunk) => {
      size += chunk.byteLength;
      if (this.total + size > this.max) over = true;
      else chunks.push(chunk);
    });
    try {
      z.push(data, true);
    } catch (e) {
      // Corrupt or truncated streams are common in the wild; keep whatever inflated cleanly.
      if (!(e instanceof Error)) throw e;
    }
    if (over) throw new PdfError("inflated size limit exceeded");
    this.total += size;
    if (size === 0) return null;
    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}

class PdfDocument {
  readonly objects = new Map<number, PdfObject>();
  readonly trailers: PdfDict[] = [];
  private readonly inflater = new Inflater(MAX_PDF_INFLATED_BYTES);

  constructor(private readonly bytes: Uint8Array) {
    this.scan();
  }

  private scan(): void {
    const text = latin1(this.bytes);
    const objRe = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = objRe.exec(text)) !== null) {
      const num = Number(m[1]);
      const lx = new Lexer(this.bytes, m.index + m[0].length);
      const value = lx.value();
      if (value === undefined) continue;
      let stream: Uint8Array | null = null;
      lx.skipWs();
      if (isDict(value) && text.startsWith("stream", lx.pos)) {
        let start = lx.pos + 6;
        if (this.bytes[start] === 0x0d) start++;
        if (this.bytes[start] === 0x0a) start++;
        const len = value.get("Length");
        let end = typeof len === "number" && start + len <= this.bytes.length && text.startsWith("endstream", skipWsAt(this.bytes, start + len)) ? start + len : -1;
        if (end < 0) {
          end = text.indexOf("endstream", start);
          if (end < 0) continue;
          while (end > start && (this.bytes[end - 1] === 0x0a || this.bytes[end - 1] === 0x0d)) end--;
        }
        stream = this.bytes.subarray(start, end);
        objRe.lastIndex = end;
      }
      // Later definitions (incremental updates) win.
      this.objects.set(num, { value, stream });
    }
    const trailerRe = /trailer\s*<</g;
    while ((m = trailerRe.exec(text)) !== null) {
      const v = new Lexer(this.bytes, m.index + 7).value();
      if (isDict(v)) this.trailers.push(v);
    }
    // Compressed object streams (PDF 1.5+).
    for (const obj of [...this.objects.values()]) {
      if (!isDict(obj.value) || !obj.stream) continue;
      if (isName(obj.value.get("Type"), "XRef")) this.trailers.push(obj.value);
      if (!isName(obj.value.get("Type"), "ObjStm")) continue;
      const data = this.decode(obj.value, obj.stream);
      const n = obj.value.get("N");
      const first = obj.value.get("First");
      if (!data || typeof n !== "number" || typeof first !== "number") continue;
      const header = new Lexer(data, 0, Math.min(first, data.length));
      const pairs: [number, number][] = [];
      for (let i = 0; i < n && i < 100000; i++) {
        const on = header.value();
        const off = header.value();
        if (typeof on !== "number" || typeof off !== "number") break;
        pairs.push([on, off]);
      }
      for (const [on, off] of pairs) {
        if (this.objects.has(on)) continue;
        const v = new Lexer(data, first + off).value();
        if (v !== undefined) this.objects.set(on, { value: v, stream: null });
      }
    }
  }

  resolve(v: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (isRef(v) && depth < 32) return this.resolve(this.objects.get(v.num)?.value, depth + 1);
    return v;
  }

  dict(v: PdfValue | undefined): PdfDict | null {
    const r = this.resolve(v);
    return isDict(r) ? r : null;
  }

  /** Decoded stream bytes, or null when the filter chain is unsupported. */
  decode(dict: PdfDict, raw: Uint8Array): Uint8Array | null {
    const f = this.resolve(dict.get("Filter"));
    const filters = f === undefined || f === null ? [] : Array.isArray(f) ? f : [f];
    let data: Uint8Array | null = raw;
    for (const filter of filters) {
      if (!data) return null;
      if (isName(filter, "FlateDecode") || isName(filter, "Fl")) data = this.inflater.inflate(data);
      else return null;
    }
    return data;
  }

  streamOf(v: PdfValue | undefined): Uint8Array | null {
    if (!isRef(v)) return null;
    const obj = this.objects.get(v.num);
    if (!obj?.stream || !isDict(obj.value)) return null;
    return this.decode(obj.value, obj.stream);
  }

  encrypted(): boolean {
    return this.trailers.some((t) => t.has("Encrypt"));
  }

  catalog(): PdfDict | null {
    for (const t of this.trailers) {
      const root = this.dict(t.get("Root"));
      if (root) return root;
    }
    for (const o of this.objects.values()) if (isDict(o.value) && isName(o.value.get("Type"), "Catalog")) return o.value;
    return null;
  }

  /** Pages in page-tree order, each with its inherited resources. */
  pages(): { page: PdfDict; resources: PdfDict | null }[] {
    const out: { page: PdfDict; resources: PdfDict | null }[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | null, inherited: PdfDict | null, depth: number) => {
      if (!node || seen.has(node) || depth > 32 || out.length >= MAX_PDF_PAGES) return;
      seen.add(node);
      const resources = this.dict(node.get("Resources")) ?? inherited;
      const kids = this.resolve(node.get("Kids"));
      if (isName(node.get("Type"), "Pages") || Array.isArray(kids)) {
        if (Array.isArray(kids)) for (const k of kids) walk(this.dict(k), resources, depth + 1);
        return;
      }
      out.push({ page: node, resources });
    };
    walk(this.dict(this.catalog()?.get("Pages")), null, 0);
    if (out.length === 0) {
      for (const o of this.objects.values()) {
        if (out.length >= MAX_PDF_PAGES) break;
        if (isDict(o.value) && isName(o.value.get("Type"), "Page")) out.push({ page: o.value, resources: this.dict(o.value.get("Resources")) });
      }
    }
    return out;
  }
}

function skipWsAt(b: Uint8Array, p: number): number {
  while (p < b.length && isWs(b[p] ?? 0)) p++;
  return p;
}

// ---------------------------------------------------------------------------
// Fonts and CMaps
// ---------------------------------------------------------------------------
interface FontDecoder {
  decode(bytes: Uint8Array): string;
}

const WIN_ANSI_EXTRA: Readonly<Record<number, string>> = {
  0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x96: "–", 0x97: "—", 0x85: "…", 0x95: "•",
};

const simpleDecoder: FontDecoder = {
  decode: (bytes) => {
    let s = "";
    for (const b of bytes) s += WIN_ANSI_EXTRA[b] ?? String.fromCharCode(b);
    return s;
  },
};

function utf16be(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(((b[i] ?? 0) << 8) | (b[i + 1] ?? 0));
  return s;
}

function bytesToInt(b: Uint8Array): number {
  let n = 0;
  for (const x of b) n = n * 256 + x;
  return n;
}

/** ToUnicode CMap: bfchar and bfrange, with code lengths from the codespace ranges. */
export function parseToUnicode(data: Uint8Array): FontDecoder {
  const map = new Map<string, string>(); // key: `${len}:${code}`
  const lengths = new Set<number>();
  const lx = new Lexer(data);
  const stack: PdfValue[] = [];
  let mode: "" | "codespace" | "bfchar" | "bfrange" = "";
  for (let guard = 0; guard < 2_000_000; guard++) {
    const v = lx.value();
    if (v === undefined) break;
    if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && v.kind === "op") {
      if (v.value === "begincodespacerange") mode = "codespace";
      else if (v.value === "beginbfchar") mode = "bfchar";
      else if (v.value === "beginbfrange") mode = "bfrange";
      else if (v.value.startsWith("end")) {
        const strs = stack.filter((x): x is PdfString | PdfValue[] => Array.isArray(x) || (typeof x === "object" && x !== null && !(x instanceof Map) && x.kind === "string"));
        if (mode === "codespace") {
          for (let i = 0; i + 1 < strs.length; i += 2) {
            const lo = strs[i];
            if (lo && !Array.isArray(lo)) lengths.add(lo.bytes.length);
          }
        } else if (mode === "bfchar") {
          for (let i = 0; i + 1 < strs.length; i += 2) {
            const src = strs[i];
            const dst = strs[i + 1];
            if (src && dst && !Array.isArray(src) && !Array.isArray(dst)) map.set(`${src.bytes.length}:${bytesToInt(src.bytes)}`, utf16be(dst.bytes));
          }
        } else if (mode === "bfrange") {
          for (let i = 0; i + 2 < strs.length; i += 3) {
            const lo = strs[i];
            const hi = strs[i + 1];
            const dst = strs[i + 2];
            if (!lo || !hi || !dst || Array.isArray(lo) || Array.isArray(hi)) continue;
            const a = bytesToInt(lo.bytes);
            const z = Math.min(bytesToInt(hi.bytes), a + 65535);
            for (let code = a; code <= z; code++) {
              const key = `${lo.bytes.length}:${code}`;
              if (Array.isArray(dst)) {
                const d = dst[code - a];
                if (typeof d === "object" && d !== null && !Array.isArray(d) && !(d instanceof Map) && d.kind === "string") map.set(key, utf16be(d.bytes));
              } else {
                const base = dst.bytes.slice();
                // Increment the last UTF-16 unit.
                const last = base.length - 1;
                if (last >= 1) {
                  const unit = (((base[last - 1] ?? 0) << 8) | (base[last] ?? 0)) + (code - a);
                  base[last - 1] = (unit >> 8) & 0xff;
                  base[last] = unit & 0xff;
                }
                map.set(key, utf16be(base));
              }
            }
          }
        }
        mode = "";
        stack.length = 0;
      }
      continue;
    }
    if (mode) stack.push(v);
  }
  const lens = [...(lengths.size ? lengths : new Set([2]))].sort((x, y) => x - y);
  return {
    decode(bytes) {
      let s = "";
      let i = 0;
      while (i < bytes.length) {
        let matched = false;
        for (const len of lens) {
          if (i + len > bytes.length) continue;
          const hit = map.get(`${len}:${bytesToInt(bytes.subarray(i, i + len))}`);
          if (hit !== undefined) {
            s += hit;
            i += len;
            matched = true;
            break;
          }
        }
        if (!matched) i += lens[0] ?? 1;
      }
      return s;
    },
  };
}

function fontDecoders(doc: PdfDocument, resources: PdfDict | null, cache: Map<PdfDict, FontDecoder>): Map<string, FontDecoder> {
  const out = new Map<string, FontDecoder>();
  const fonts = doc.dict(resources?.get("Font"));
  if (!fonts) return out;
  for (const [name, ref] of fonts) {
    const font = doc.dict(ref);
    if (!font) continue;
    let dec = cache.get(font);
    if (!dec) {
      const tu = doc.streamOf(font.get("ToUnicode"));
      if (tu) dec = parseToUnicode(tu);
      else if (isName(font.get("Subtype"), "Type0")) dec = { decode: () => "" }; // no way to map CIDs to text
      else dec = simpleDecoder;
      cache.set(font, dec);
    }
    out.set(name, dec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content streams
// ---------------------------------------------------------------------------
function contentText(data: Uint8Array, fonts: Map<string, FontDecoder>): string {
  const lx = new Lexer(data);
  const operands: PdfValue[] = [];
  let font: FontDecoder = simpleDecoder;
  let out = "";
  let y: number | null = null;
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const show = (v: PdfValue | undefined) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && v.kind === "string") out += font.decode(v.bytes);
  };
  for (let guard = 0; guard < 5_000_000; guard++) {
    const v = lx.value();
    if (v === undefined) break;
    if (!(typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && v.kind === "op")) {
      operands.push(v);
      if (operands.length > 64) operands.shift();
      continue;
    }
    const op = v.value;
    switch (op) {
      case "BI": {
        // Inline image: skip to "EI" delimited by whitespace.
        const text = latin1(data.subarray(lx.pos, Math.min(data.length, lx.pos + 1_000_000)));
        const at = text.search(/\sEI(?:\s|$)/);
        lx.pos = at < 0 ? data.length : lx.pos + at + 3;
        break;
      }
      case "Tf": {
        const name = operands[operands.length - 2];
        if (isName(name)) font = fonts.get(name.value) ?? simpleDecoder;
        break;
      }
      case "Td":
      case "TD": {
        const ty = operands[operands.length - 1];
        const tx = operands[operands.length - 2];
        if (typeof ty === "number" && Math.abs(ty) > 0.01) {
          newline();
          if (y !== null) y += ty;
        } else if (typeof tx === "number" && tx > 0 && out && !/\s$/.test(out)) out += " ";
        break;
      }
      case "Tm": {
        const f = operands[operands.length - 1];
        if (typeof f === "number") {
          if (y === null || Math.abs(f - y) > 0.5) newline();
          else if (out && !/\s$/.test(out)) out += " ";
          y = f;
        }
        break;
      }
      case "T*":
        newline();
        break;
      case "Tj":
        show(operands[operands.length - 1]);
        break;
      case "'":
        newline();
        show(operands[operands.length - 1]);
        break;
      case '"':
        newline();
        show(operands[operands.length - 1]);
        break;
      case "TJ": {
        const arr = operands[operands.length - 1];
        if (Array.isArray(arr)) {
          for (const part of arr) {
            if (typeof part === "number") {
              if (part < -180 && out && !/\s$/.test(out)) out += " ";
            } else show(part);
          }
        }
        break;
      }
      case "ET":
        break;
      case "BT":
        break;
      default:
        break;
    }
    operands.length = 0;
  }
  return out;
}

export interface PdfTextResult {
  readonly status: "ok" | "encrypted" | "no_text" | "unreadable";
  readonly text: string;
  readonly pages: number;
}

/** Extracts page text in reading order of the content streams (first {@link MAX_PDF_PAGES} pages). */
export function pdfText(bytes: Uint8Array): PdfTextResult {
  let doc: PdfDocument;
  try {
    doc = new PdfDocument(bytes);
  } catch (e) {
    if (e instanceof PdfError) return { status: "unreadable", text: "", pages: 0 };
    throw e;
  }
  if (doc.encrypted()) return { status: "encrypted", text: "", pages: 0 };
  const cache = new Map<PdfDict, FontDecoder>();
  const pages = doc.pages();
  const texts: string[] = [];
  try {
    for (const { page, resources } of pages) {
      const fonts = fontDecoders(doc, resources, cache);
      const contents = doc.resolve(page.get("Contents"));
      const refs = Array.isArray(contents) ? contents : [page.get("Contents")];
      const parts: Uint8Array[] = [];
      for (const r of refs) {
        const s = doc.streamOf(r);
        if (s) parts.push(s);
      }
      const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength + 1, 0));
      let o = 0;
      for (const p of parts) {
        joined.set(p, o);
        o += p.byteLength;
        joined[o++] = 0x0a;
      }
      texts.push(contentText(joined, fonts));
    }
  } catch (e) {
    if (e instanceof PdfError) return { status: "unreadable", text: "", pages: pages.length };
    throw e;
  }
  const text = texts.join("\n").split(String.fromCharCode(0)).join("");
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return { status: letters >= 3 ? "ok" : "no_text", text, pages: pages.length };
}

const MANUAL = "Paste the table of contents text instead (scanned or protected PDFs are not read; OCR is not available).";

/** PDF → TOC chapters, or `needs_manual_toc` when no text layer could be read. */
export function extractPdfToc(bytes: Uint8Array): ExtractionResult {
  const r = pdfText(bytes);
  if (r.status !== "ok") {
    const why = r.status === "encrypted" ? "The PDF is encrypted." : r.status === "no_text" ? "The PDF has no readable text layer." : "The PDF could not be read.";
    return { status: "needs_manual_toc", chapters: [], errors: [{ row: null, code: "needs_manual_toc", message: `${why} ${MANUAL}`, severity: "error" }] };
  }
  const toc = extractTocLines(r.text);
  if (toc.status !== "ok") {
    return { status: "needs_manual_toc", chapters: [], errors: [{ row: null, code: "needs_manual_toc", message: `No table of contents was recognised in the PDF text. ${MANUAL}`, severity: "error" }] };
  }
  return toc;
}
