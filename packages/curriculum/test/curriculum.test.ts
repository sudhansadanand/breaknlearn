import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  MAX_CHAPTERS,
  docxParagraphs,
  escapeFormula,
  extractChapters,
  extractDocxToc,
  extractPdfToc,
  extractTocLines,
  normalizeTokens,
  parseCsv,
  parseTocCsv,
  pdfText,
  readZipEntry,
  stem,
  subjectKeyFor,
  suggestForChapter,
  type CandidateNode,
} from "../src";
import { buildPdf, flate, lit, utf8 } from "./pdf-builder";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
const G2_MATH = { grade: 2, subjectKey: "math" } as const;

describe("parseCsv (RFC 4180)", () => {
  it("handles quotes, escaped quotes, embedded newlines, CRLF and BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n"multi\nline",z\n\n')).toEqual([
      ["a", "b"],
      ["x,1", 'he said "hi"'],
      ["multi\nline", "z"],
    ]);
    expect(parseCsv("a,b\n1,")).toEqual([["a", "b"], ["1", ""]]);
  });

  it("rejects malformed quoting", () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(/Unterminated/);
    expect(() => parseCsv('a,"b"c\n')).toThrow(/after closing quote/);
    expect(() => parseCsv('a,b"c"\n')).toThrow(/Quote inside/);
  });
});

describe("parseTocCsv", () => {
  it("stages the good fixture with pages, numbers and full confidence", () => {
    const r = parseTocCsv(fixture("toc-good.csv").toString("utf8"), G2_MATH);
    expect(r.status).toBe("ok");
    expect(r.errors).toEqual([]);
    expect(r.chapters.map((c) => [c.chapterNumber, c.title, c.pageStart, c.sortOrder])).toEqual([
      ["1", "Numbers up to 100", 1, 1],
      ["2", "Shapes and Patterns", 14, 2],
      ["3", 'Measurement: length, weight "and" time', 27, 3],
      ["4", "Multiplication Tables", 40, 4],
    ]);
    expect(r.chapters.every((c) => c.extractionConfidence === 1)).toBe(true);
  });

  it("reports row-level errors by record number and keeps valid rows", () => {
    const r = parseTocCsv(fixture("toc-bad.csv").toString("utf8"), G2_MATH);
    const codes = r.errors.map((e) => `${e.row}:${e.code}`);
    expect(codes).toEqual([
      "3:title_required",
      "4:markup_not_allowed",
      "5:formula_escaped",
      "6:bad_page_start",
      "7:bad_grade",
      "8:bad_subject",
      "9:grade_mismatch",
      "10:column_count",
      "11:subject_mismatch",
      "12:bad_chapter_no",
    ]);
    expect(r.errors.find((e) => e.code === "formula_escaped")?.severity).toBe("warning");
    expect(r.chapters.map((c) => c.title)).toEqual(["Numbers", `'=HYPERLINK("http://evil.example")`]);
    expect(r.chapters[1]!.flags).toContain("formula_escaped");
    // Messages never echo the submitted value.
    expect(JSON.stringify(r.errors)).not.toContain("script");
    expect(JSON.stringify(r.errors)).not.toContain("evil");
  });

  it("requires the exact header", () => {
    expect(parseTocCsv("title,page\nA,1\n", G2_MATH).errors[0]!.code).toBe("bad_header");
    expect(parseTocCsv("chapter_no,title,page_start,grade,subject,extra\n", G2_MATH).errors[0]!.code).toBe("bad_header");
    expect(parseTocCsv("", G2_MATH).errors[0]!.code).toBe("empty_file");
    expect(parseTocCsv("chapter_no,title,page_start,grade,subject\n", G2_MATH).errors[0]!.code).toBe("no_rows");
    // Column order is free.
    expect(parseTocCsv("subject,grade,title,page_start,chapter_no\nmath,2,Shapes,3,1\n", G2_MATH).chapters).toHaveLength(1);
  });

  it("caps rows at 500 and titles at 200 characters", () => {
    const rows = Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => `${i + 1},Chapter title ${i + 1},${i + 1},2,math`).join("\n");
    const r = parseTocCsv(`chapter_no,title,page_start,grade,subject\n${rows}\n`, G2_MATH);
    expect(r.status).toBe("invalid");
    expect(r.chapters).toHaveLength(0);
    expect(r.errors[0]!.code).toBe("too_many_rows");
    const exactly = Array.from({ length: MAX_CHAPTERS }, (_, i) => `${i + 1},T${i + 1},${i + 1},2,math`).join("\n");
    expect(parseTocCsv(`chapter_no,title,page_start,grade,subject\n${exactly}\n`, G2_MATH).chapters).toHaveLength(MAX_CHAPTERS);
    const long = parseTocCsv(`chapter_no,title,page_start,grade,subject\n1,${"x".repeat(201)},1,2,math\n`, G2_MATH);
    expect(long.errors[0]!.code).toBe("title_too_long");
  });

  it("maps subjects per grade", () => {
    expect(subjectKeyFor(6, "History & Civics")).toBe("history_civics");
    expect(subjectKeyFor(6, "Mathematics")).toBe("math");
    expect(subjectKeyFor(2, "physics")).toBeNull();
    expect(subjectKeyFor(6, "music")).toBeNull();
    expect(subjectKeyFor(2, "Music")).toBe("music");
  });

  it("escapes every formula prefix", () => {
    for (const p of ["=", "+", "-", "@", "\t"]) expect(escapeFormula(`${p}x`)).toBe(`'${p}x`);
    expect(escapeFormula("Shapes")).toBe("Shapes");
  });
});

describe("extractTocLines", () => {
  it("extracts numbered chapters with pages from the text fixture", () => {
    const r = extractTocLines(fixture("toc-text.txt").toString("utf8"));
    expect(r.status).toBe("ok");
    expect(r.chapters.map((c) => [c.chapterNumber, c.title, c.pageStart])).toEqual([
      ["1", "Numbers up to 100", 1],
      ["2", "Shapes and Patterns", 14],
      ["3", "Measurement", 27],
      ["4", "Money", 36],
      ["5", "Tables of 2 to 10", 41],
      ["6", "Data Handling", 52],
    ]);
    const [first, , third] = r.chapters;
    expect(first!.extractionConfidence).toBeGreaterThan(third!.extractionConfidence);
    expect(r.chapters.every((c) => c.extractionConfidence > 0 && c.extractionConfidence <= 1)).toBe(true);
  });

  it("handles the spec examples", () => {
    expect(extractTocLines("3. Shapes and Patterns ........ 24").chapters[0]).toMatchObject({ chapterNumber: "3", title: "Shapes and Patterns", pageStart: 24 });
    expect(extractTocLines("Chapter 4 – Measurement 31").chapters[0]).toMatchObject({ chapterNumber: "4", title: "Measurement", pageStart: 31 });
    expect(extractTocLines("Lesson IV: Plants Around Us … 18").chapters[0]).toMatchObject({ chapterNumber: "IV", title: "Plants Around Us", pageStart: 18 });
  });

  it("keeps numbers that are part of a title", () => {
    expect(extractTocLines("Numbers up to 100\nShapes").chapters.map((c) => [c.title, c.pageStart])).toEqual([
      ["Numbers up to 100", null],
      ["Shapes", null],
    ]);
  });

  it("flags out-of-order pages and lowers confidence", () => {
    const r = extractTocLines("1. A ..... 10\n2. B ..... 4");
    expect(r.chapters[1]!.flags).toContain("page_out_of_order");
    expect(r.chapters[1]!.extractionConfidence).toBeLessThan(r.chapters[0]!.extractionConfidence);
    expect(r.errors.map((e) => e.code)).toEqual(["page_out_of_order"]);
  });

  it("skips markup lines with an error and escapes formula titles", () => {
    const r = extractTocLines("1. <img src=x onerror=alert(1)> ..... 3\n2. =cmd|' /C calc'!A0 ..... 5\n3. Shapes ..... 7");
    expect(r.errors.map((e) => `${e.row}:${e.code}`)).toEqual(["1:markup_not_allowed", "2:formula_escaped"]);
    expect(r.chapters.map((c) => c.title)).toEqual(["'=cmd|' /C calc'!A0", "Shapes"]);
  });

  it("returns invalid when nothing looks like a chapter", () => {
    const r = extractTocLines("\n\n12 34\n");
    expect(r.status).toBe("invalid");
    expect(r.errors.at(-1)!.code).toBe("no_chapters_found");
  });
});

function docx(paragraphs: string[], extra: Record<string, Uint8Array> = {}): Uint8Array {
  const body = paragraphs
    .map((p) => `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>${p.split("\t").map((part, i) => `${i ? "<w:r><w:tab/></w:r>" : ""}<w:r><w:t xml:space="preserve">${part.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r>`).join("")}</w:p>`)
    .join("");
  return zipSync({
    "[Content_Types].xml": utf8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": utf8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    ...extra,
  });
}

describe("DOCX", () => {
  it("extracts paragraphs (runs, tabs, entities) and TOC chapters", () => {
    const bytes = docx(["Contents", "1. Numbers & Numerals\t3", "2. Shapes and Patterns\t14", "Chapter 3 – Measurement 27"]);
    expect(docxParagraphs(bytes)).toEqual(["Contents", "1. Numbers & Numerals\t3", "2. Shapes and Patterns\t14", "Chapter 3 – Measurement 27"]);
    const r = extractDocxToc(bytes);
    expect(r.status).toBe("ok");
    expect(r.chapters.map((c) => [c.title, c.pageStart])).toEqual([
      ["Numbers & Numerals", 3],
      ["Shapes and Patterns", 14],
      ["Measurement", 27],
    ]);
  });

  it("decoded markup in a run is still rejected as a title", () => {
    const r = extractDocxToc(docx(["1. <script>alert(1)</script> ..... 3", "2. Shapes ..... 5"]));
    expect(r.errors[0]!.code).toBe("markup_not_allowed");
    expect(r.chapters.map((c) => c.title)).toEqual(["Shapes"]);
  });

  it("rejects zips without word/document.xml and stops zip bombs early", () => {
    const notDocx = zipSync({ "xl/workbook.xml": utf8("<x/>") });
    expect(extractDocxToc(notDocx).errors[0]!.code).toBe("docx_not_docx");
    const bomb = zipSync({ "word/document.xml": new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => readZipEntry(bomb, "word/document.xml", 1024 * 1024)).toThrow(/too large/);
    expect(extractDocxToc(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9])).status).toBe("invalid");
  });

  it("an empty document needs a manual TOC", () => {
    expect(extractDocxToc(docx([])).status).toBe("needs_manual_toc");
  });
});

/** Two-page PDF: page 1 simple Helvetica (uncompressed), page 2 Type0 + ToUnicode (Flate, hex, TJ). */
function textPdf(): Uint8Array {
  const page1 = ["BT /F1 12 Tf 72 720 Td (Contents) Tj", "0 -20 Td (1. Numbers up to 100 ........ ) Tj (1) Tj", "0 -20 Td [(2. Shapes and P) 20 (atterns)] TJ 300 0 Td (14) Tj", "ET"].join("\n");
  // Glyph codes: A-Z -> 0x0101.., a-z -> 0x0201.., space 0x0300, digits 0x0310.., dash 0x0320, dot 0x0321
  const code = (ch: string): string => {
    const c = ch.charCodeAt(0);
    let g: number;
    if (ch >= "A" && ch <= "Z") g = 0x0101 + (c - 65);
    else if (ch >= "a" && ch <= "z") g = 0x0201 + (c - 97);
    else if (ch >= "0" && ch <= "9") g = 0x0310 + (c - 48);
    else if (ch === " ") g = 0x0300;
    else if (ch === "–") g = 0x0320;
    else g = 0x0321;
    return g.toString(16).padStart(4, "0");
  };
  const hex = (s: string) => `<${[...s].map(code).join("")}>`;
  const page2 = [
    "BT /F2 11 Tf",
    `1 0 0 1 72 700 Tm ${hex("Chapter 3 – Measurement")} Tj`,
    `1 0 0 1 400 700 Tm ${hex("27")} Tj`,
    `1 0 0 1 72 680 Tm [${hex("4. Money")} -400 ${hex("36")}] TJ`,
    "ET",
  ].join("\n");
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    "3 beginbfrange <0101> <011A> <0041> <0201> <021A> <0061> <0310> <0319> <0030> endbfrange",
    "3 beginbfchar <0300> <0020> <0320> <2013> <0321> <002E> endbfchar",
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  return buildPdf(
    [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>" },
      { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>" },
      { num: 4, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [8 0 R] >>" },
      { num: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
      { num: 6, body: "<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /ToUnicode 9 0 R >>" },
      { num: 7, body: "<< >>", stream: utf8(page1) },
      { num: 8, body: "<< /Filter /FlateDecode >>", stream: flate(page2) },
      { num: 9, body: "<< /Filter /FlateDecode >>", stream: flate(cmap) },
    ],
    "<< /Size 10 /Root 1 0 R >>",
  );
}

describe("PDF text extraction", () => {
  it("reads simple and ToUnicode fonts in page order", () => {
    const r = pdfText(textPdf());
    expect(r.status).toBe("ok");
    expect(r.pages).toBe(2);
    expect(r.text.split("\n").map((l) => l.trim())).toEqual([
      "Contents",
      "1. Numbers up to 100 ........ 1",
      "2. Shapes and Patterns 14",
      "Chapter 3 – Measurement 27",
      "4. Money 36",
    ]);
  });

  it("turns the PDF TOC into chapters", () => {
    const r = extractPdfToc(textPdf());
    expect(r.status).toBe("ok");
    expect(r.chapters.map((c) => [c.chapterNumber, c.title, c.pageStart])).toEqual([
      ["1", "Numbers up to 100", 1],
      ["2", "Shapes and Patterns", 14],
      ["3", "Measurement", 27],
      ["4", "Money", 36],
    ]);
  });

  it("reads objects from compressed object streams", () => {
    const objstmBody = "3 0 4 52 ";
    const objs = "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>    << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    const first = objstmBody.length;
    const pdf = buildPdf(
      [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> >>" },
        { num: 5, body: `<< /Type /ObjStm /N 2 /First ${first} /Filter /FlateDecode >>`, stream: flate(objstmBody + objs) },
        { num: 7, body: "<< /Filter /FlateDecode >>", stream: flate(`BT /F1 12 Tf 72 700 Td ${lit("1. Plants (and) Animals ..... 5")} Tj ET`) },
      ],
      "<< /Size 8 /Root 1 0 R >>",
    );
    expect(extractPdfToc(pdf).chapters.map((c) => [c.title, c.pageStart])).toEqual([["Plants (and) Animals", 5]]);
  });

  it("encrypted, image-only and garbage PDFs need a manual TOC (no OCR)", () => {
    const encrypted = buildPdf([{ num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" }, { num: 2, body: "<< /Type /Pages /Kids [] /Count 0 >>" }], "<< /Size 3 /Root 1 0 R /Encrypt << /Filter /Standard >> >>");
    expect(pdfText(encrypted).status).toBe("encrypted");
    expect(extractPdfToc(encrypted)).toMatchObject({ status: "needs_manual_toc", chapters: [] });
    const imageOnly = buildPdf(
      [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
        { num: 4, body: "<< >>", stream: utf8("q 612 0 0 792 0 0 cm /Im1 Do Q") },
      ],
      "<< /Size 5 /Root 1 0 R >>",
    );
    expect(extractPdfToc(imageOnly).errors[0]!.code).toBe("needs_manual_toc");
    expect(extractPdfToc(utf8("%PDF-1.4 garbage")).status).toBe("needs_manual_toc");
  });

  it("dispatches by kind", () => {
    expect(extractChapters("pdf", textPdf(), G2_MATH).chapters).toHaveLength(4);
    expect(extractChapters("csv", fixture("toc-good.csv"), G2_MATH).chapters).toHaveLength(4);
    expect(extractChapters("text", fixture("toc-text.txt"), G2_MATH).chapters).toHaveLength(6);
    expect(extractChapters("docx", docx(["1. Shapes ..... 4"]), G2_MATH).chapters).toHaveLength(1);
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NODES: CandidateNode[] = [
  { id: id(1), stableKey: "grade2.math.numbers_and_number_operations", grade: 2, subjectKey: "math", title: "Numbers and Number Operations" },
  { id: id(2), stableKey: "grade2.math.geometry", grade: 2, subjectKey: "math", title: "Geometry" },
  { id: id(3), stableKey: "grade2.math.measurement", grade: 2, subjectKey: "math", title: "Measurement" },
  { id: id(4), stableKey: "grade2.math.data_handling", grade: 2, subjectKey: "math", title: "Data Handling" },
  { id: id(5), stableKey: "grade2.math.patterns", grade: 2, subjectKey: "math", title: "Patterns" },
  { id: id(6), stableKey: "grade2.math.multiplication", grade: 2, subjectKey: "math", title: "Multiplication Tables" },
  { id: id(7), stableKey: "grade2.english.reading", grade: 2, subjectKey: "english", title: "Reading" },
  { id: id(8), stableKey: "grade6.math.geometry", grade: 6, subjectKey: "math", title: "Geometry" },
];

describe("mapping suggester", () => {
  it("normalises case, punctuation, stopwords, plurals and synonyms", () => {
    expect(normalizeTokens("The SHAPES & Patterns!")).toEqual(["geometry", "pattern"]);
    expect(normalizeTokens("Chapter 3: Measuring Lengths")).toEqual(["measur", "measurement"]);
    expect(stem("activities")).toBe("activity");
    expect(stem("boxes")).toBe("box");
  });

  it("suggests one-to-many topics with confidence and respects grade", () => {
    const s = suggestForChapter({ title: "Shapes and Patterns", grade: 2, subjectKey: "math" }, NODES);
    expect(s.map((x) => x.stableKey)).toEqual(["grade2.math.geometry", "grade2.math.patterns"]);
    expect(s.every((x) => x.confidence > 0.5 && x.confidence <= 1)).toBe(true);
    expect(s.some((x) => x.stableKey.startsWith("grade6"))).toBe(false);
  });

  it("is deterministic, top-3, thresholded", () => {
    const ch = { title: "Tables of 2 to 10", grade: 2 as const, subjectKey: "math" };
    expect(suggestForChapter(ch, NODES)).toEqual(suggestForChapter(ch, [...NODES].reverse()));
    expect(suggestForChapter(ch, NODES)[0]).toMatchObject({ stableKey: "grade2.math.multiplication", confidence: 1 });
    expect(suggestForChapter({ title: "Fun with Rhymes", grade: 2, subjectKey: "math" }, NODES)).toEqual([]);
    expect(suggestForChapter({ title: "Shapes and Patterns", grade: 2, subjectKey: "math" }, NODES, { threshold: 0.95 })).toEqual([]);
    expect(suggestForChapter({ title: "Shapes Patterns Data Measurement Numbers", grade: 2, subjectKey: "math" }, NODES).length).toBe(3);
  });

  it("down-weights other subjects of the same grade", () => {
    const [same] = suggestForChapter({ title: "Reading", grade: 2, subjectKey: "english" }, NODES);
    const [other] = suggestForChapter({ title: "Reading", grade: 2, subjectKey: "math" }, NODES);
    expect(same!.confidence).toBe(1);
    expect(other!.confidence).toBe(0.5);
  });

  it("ignores the formula-escape apostrophe", () => {
    expect(suggestForChapter({ title: "'-Geometry", grade: 2, subjectKey: "math" }, NODES)[0]!.stableKey).toBe("grade2.math.geometry");
  });
});
