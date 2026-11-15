/** A9-PRIV-01: the portal's consent wording and docs/privacy/CONSENT_TEXT.md are the same text, version and scopes. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConsentRequest } from "../../src/server/handlers/admin";
import {
  CONSENT_SCOPES,
  CONSENT_SECTIONS,
  CONSENT_STATUS,
  CONSENT_TITLE,
  CONSENT_VERSION,
  DECLARATION,
  DRAFT_NOTICE,
  SCOPE_TEXT,
} from "../../src/server/privacy/consent-text";

const md = readFileSync(new URL("../../../../docs/privacy/CONSENT_TEXT.md", import.meta.url), "utf8");

describe("consent text v1", () => {
  it("has a version string the consent API and the database accept", () => {
    expect(CONSENT_VERSION).toBe("bnl-consent-2026-11-v1");
    expect(ConsentRequest.safeParse({ consent_version: CONSENT_VERSION, decision: "grant" }).success).toBe(true);
    expect(CONSENT_VERSION.length).toBeLessThanOrEqual(40); // consent_records.consent_version check
  });

  it("is marked DRAFT until the owner approves it", () => {
    expect(CONSENT_STATUS).toBe("draft");
    expect(DRAFT_NOTICE).toMatch(/^DRAFT, pending owner approval/);
    expect(md).toContain(DRAFT_NOTICE);
  });

  it("docs/privacy/CONSENT_TEXT.md contains every sentence of the code, so the two never drift", () => {
    const strings = [
      CONSENT_TITLE, CONSENT_VERSION, DECLARATION,
      ...CONSENT_SECTIONS.flatMap((s) => [s.heading, ...s.paragraphs, ...s.bullets]),
      ...CONSENT_SCOPES.flatMap((k) => [k, SCOPE_TEXT[k].label, SCOPE_TEXT[k].statement, SCOPE_TEXT[k].required, SCOPE_TEXT[k].ifOff]),
    ];
    expect(strings.filter((s) => !md.includes(s))).toEqual([]);
  });

  it("covers the required topics in plain language and makes no certification claim", () => {
    const all = JSON.stringify({ CONSENT_SECTIONS, SCOPE_TEXT, DECLARATION });
    expect(CONSENT_SECTIONS.map((s) => s.id)).toEqual(["about", "collected", "not-collected", "why", "who", "retention", "rights"]);
    for (const needle of ["first name or nickname", "grade", "avatar", "Quiz answers", "On-screen time", "device identifier", "syllabus",
      "90 days", "395 days", "Digital Personal Data Protection Act, 2023", "verifiable consent", "No advertising", "no sale of data",
      "Withdraw consent", "download a copy", "Delete", "within 7 days", "household owner"]) {
      expect(all, needle).toContain(needle);
    }
    expect(all).not.toMatch(/\bcomplian(t|ce)\b|certified|guarantee/i);
    expect(CONSENT_SCOPES).toEqual(["learning_data", "telemetry", "school_uploads"]);
  });
});
