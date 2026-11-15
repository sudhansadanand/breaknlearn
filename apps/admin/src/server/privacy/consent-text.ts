/**
 * Parental notice and consent wording, version 1 (A9-PRIV-01). STATUS: DRAFT, pending owner approval in the PR.
 * docs/privacy/CONSENT_TEXT.md carries the same text; test/privacy/consent-text.test.ts keeps the two identical.
 * Changing any sentence here is a new consent version: bump CONSENT_VERSION (the portal then asks parents to review).
 */

export const CONSENT_VERSION = "bnl-consent-2026-11-v1";
export const CONSENT_STATUS: "draft" | "approved" = "draft";

export const CONSENT_SCOPES = ["learning_data", "telemetry", "school_uploads"] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const isConsentScope = (v: unknown): v is ConsentScope => typeof v === "string" && (CONSENT_SCOPES as readonly string[]).includes(v);

export interface ConsentSection {
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly bullets: readonly string[];
}

export interface ScopeText {
  readonly label: string;
  readonly statement: string;
  readonly required: string;
  readonly ifOff: string;
}

export const CONSENT_TITLE = "Notice to parents and request for consent";

export const DRAFT_NOTICE =
  "DRAFT, pending owner approval. This wording describes what the software does. It is not legal advice and has not been reviewed by a lawyer; have it reviewed before relying on it.";

export const CONSENT_SECTIONS: readonly ConsentSection[] = [
  {
    id: "about",
    heading: "About this notice",
    paragraphs: [
      "BreakNLearn is a learning app your children use on the family TV, with a parent portal for the adults of the household. This notice explains in plain language what information about your children the app keeps, why, who can see it, how long it is kept, and what you can do about it.",
      "India's Digital Personal Data Protection Act, 2023 says that a child's personal data may be processed only with the verifiable consent of a parent or lawful guardian. That is why the app asks you, a signed-in parent, to choose below what you agree to. You can change your choices at any time on this page.",
      "BreakNLearn is run privately for your household by the household owner (the adult who set up this family account). It has no other customers, no advertising and no paid features.",
    ],
    bullets: [],
  },
  {
    id: "collected",
    heading: "What the app collects",
    paragraphs: [],
    bullets: [
      "Each child's first name or nickname, school grade, and the picture (avatar) they choose.",
      "Lesson progress: which lessons and steps were opened or finished, and where to resume.",
      "Quiz answers: which option your child chose for each question, whether it was right, and how long it took.",
      "On-screen time while lessons play: when a lesson starts and ends and how long it was visible and playing on the TV. This is an estimate of time on screen, not a measure of attention.",
      "For each paired TV: a random device identifier, the name you gave it (for example \"Living room TV\") and when it last connected.",
      "Optional: school syllabus or textbook contents pages that you choose to upload (PDF, Word or CSV), and the chapter list read from them.",
      "About the adults: your email address and the sign-in records needed to keep the account secure, and a log of important actions (for example \"TV paired\" or \"consent given\") that contains identifiers, not names.",
    ],
  },
  {
    id: "not-collected",
    heading: "What the app does not collect",
    paragraphs: [],
    bullets: [
      "No child email address, birth date, photo, voice, video, location or contacts.",
      "No camera or microphone use, and no free text typed by children (quiz answers are choices from a list).",
      "No advertising identifiers and no third-party analytics or tracking tools.",
    ],
  },
  {
    id: "why",
    heading: "Why it is used",
    paragraphs: ["The information is used only for these purposes:"],
    bullets: [
      "To show you each child's progress and history in the parent portal.",
      "To let a child continue a lesson where they left off on any TV paired to your household.",
      "To schedule short review quizzes at the right time.",
      "To calculate learning scores and suggestions for you, the parent. Scores are estimates to help you; nobody else uses them to make decisions about your child.",
      "To keep the service secure, for example to detect and block a stolen TV credential.",
    ],
  },
  {
    id: "who",
    heading: "Who can see it",
    paragraphs: [],
    bullets: [
      "Only the adults of your household who have a parent account (owner or guardian), and the TVs you have paired.",
      "No advertising, no sale of data, no sharing with other families or schools, and no third-party analytics.",
      "People who write lessons for the app never see children's data.",
      "The app runs on service providers that store and process the data only on the owner's behalf: the hosting provider and the database and file storage provider. They may not use it for their own purposes.",
    ],
  },
  {
    id: "retention",
    heading: "How long it is kept",
    paragraphs: [],
    bullets: [
      "Detailed activity records (each lesson step, on-screen time update and quiz event as it happened): 90 days, then deleted automatically.",
      "Summaries (time totals per session, quiz results, review schedule, learning scores and suggestions): about 13 months (395 days), then deleted automatically.",
      "Child profiles, lesson progress and school uploads: until you delete them or the whole household.",
      "Backups are kept for a limited period and then overwritten, so deleted data can remain in a backup until it ages out.",
    ],
  },
  {
    id: "rights",
    heading: "Your choices and rights",
    paragraphs: [],
    bullets: [
      "See and download: download a copy of all your household's data from this page at any time.",
      "Correct: change a child's name, grade or avatar on the Children page.",
      "Withdraw consent: switch off any choice below; withdrawing is as easy as giving consent. The app stops collecting that kind of data immediately. Data already collected is kept until you ask for it to be deleted.",
      "Delete: the household owner can ask for one child's data, the detailed activity records, or the whole household to be deleted. Deletion is carried out at the next nightly run, and always within 7 days.",
      "On the TV itself, children's names are also kept in the TV browser's storage. Remove them on the TV (Profiles, then edit, then delete) or by clearing the site's data.",
      "Questions, corrections or complaints: contact the household owner, who operates this app. If you are not satisfied, Indian law gives you the right to complain to the Data Protection Board of India.",
    ],
  },
];

export const SCOPE_TEXT: Readonly<Record<ConsentScope, ScopeText>> = {
  learning_data: {
    label: "Profiles, lesson progress and quiz answers",
    statement:
      "I agree that the app may store my children's profiles, lesson progress and quiz answers, and use them to resume lessons, schedule reviews and calculate learning scores for me.",
    required: "Needed to pair a TV, sync progress, import old progress and take quizzes.",
    ifOff: "If this is off, TVs cannot be paired and paired TVs stop sending anything; the TV still works on its own.",
  },
  telemetry: {
    label: "Detailed activity and on-screen time",
    statement:
      "I agree that the app may record when lessons start and end, which steps are shown and how long lessons play on screen, so that I can see time spent and scores are more accurate.",
    required: "Optional. Also needs the first choice.",
    ifOff: "If this is off, no activity or screen-time records are kept; progress and quizzes still work.",
  },
  school_uploads: {
    label: "School syllabus uploads",
    statement: "I agree that adults of my household may upload school syllabus documents so that lessons can be matched to the school's chapters.",
    required: "Optional.",
    ifOff: "If this is off, new school documents cannot be uploaded; documents already uploaded are kept until deleted.",
  },
};

export const DECLARATION =
  "By switching a choice on, I confirm that I am the parent or lawful guardian of the children who use this app in my household, and that I agree to what is described above for that choice. The app records which adult account gave or withdrew consent, when, and for which version of this notice.";
