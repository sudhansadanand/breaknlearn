# Notice to parents and request for consent

**Version:** `bnl-consent-2026-11-v1`  
**Status:** Approved by the household owner on 2026-11-15. This wording describes what the software does. It is not legal advice and has not been reviewed by a lawyer; a legal review is still recommended.

> Source of truth for the portal is `apps/admin/src/server/privacy/consent-text.ts`; `apps/admin/test/privacy/consent-text.test.ts` fails if this file and the code differ. Any wording change is a new version.

## About this notice

BreakNLearn is a learning app your children use on the family TV, with a parent portal for the adults of the household. This notice explains in plain language what information about your children the app keeps, why, who can see it, how long it is kept, and what you can do about it.

India's Digital Personal Data Protection Act, 2023 says that a child's personal data may be processed only with the verifiable consent of a parent or lawful guardian. That is why the app asks you, a signed-in parent, to choose below what you agree to. You can change your choices at any time on this page.

BreakNLearn is run privately for your household by the household owner (the adult who set up this family account). It has no other customers, no advertising and no paid features.

## What the app collects

- Each child's first name or nickname, school grade, and the picture (avatar) they choose.
- Lesson progress: which lessons and steps were opened or finished, and where to resume.
- Quiz answers: which option your child chose for each question, whether it was right, and how long it took.
- On-screen time while lessons play: when a lesson starts and ends and how long it was visible and playing on the TV. This is an estimate of time on screen, not a measure of attention.
- For each paired TV: a random device identifier, the name you gave it (for example "Living room TV") and when it last connected.
- Optional: school syllabus or textbook contents pages that you choose to upload (PDF, Word or CSV), and the chapter list read from them.
- About the adults: your email address and the sign-in records needed to keep the account secure, and a log of important actions (for example "TV paired" or "consent given") that contains identifiers, not names.

## What the app does not collect

- No child email address, birth date, photo, voice, video, location or contacts.
- No camera or microphone use, and no free text typed by children (quiz answers are choices from a list).
- No advertising identifiers and no third-party analytics or tracking tools.

## Why it is used

The information is used only for these purposes:

- To show you each child's progress and history in the parent portal.
- To let a child continue a lesson where they left off on any TV paired to your household.
- To schedule short review quizzes at the right time.
- To calculate learning scores and suggestions for you, the parent. Scores are estimates to help you; nobody else uses them to make decisions about your child.
- To keep the service secure, for example to detect and block a stolen TV credential.

## Who can see it

- Only the adults of your household who have a parent account (owner or guardian), and the TVs you have paired.
- No advertising, no sale of data, no sharing with other families or schools, and no third-party analytics.
- People who write lessons for the app never see children's data.
- The app runs on service providers that store and process the data only on the owner's behalf: the hosting provider and the database and file storage provider. They may not use it for their own purposes.

## How long it is kept

- Detailed activity records (each lesson step, on-screen time update and quiz event as it happened): 90 days, then deleted automatically.
- Summaries (time totals per session, quiz results, review schedule, learning scores and suggestions): about 13 months (395 days), then deleted automatically.
- Child profiles, lesson progress and school uploads: until you delete them or the whole household.
- Backups are kept for a limited period and then overwritten, so deleted data can remain in a backup until it ages out.

## Your choices and rights

- See and download: download a copy of all your household's data from this page at any time.
- Correct: change a child's name, grade or avatar on the Children page.
- Withdraw consent: switch off any choice below; withdrawing is as easy as giving consent. The app stops collecting that kind of data immediately. Data already collected is kept until you ask for it to be deleted.
- Delete: the household owner can ask for one child's data, the detailed activity records, or the whole household to be deleted. Deletion is carried out at the next nightly run, and always within 7 days.
- On the TV itself, children's names are also kept in the TV browser's storage. Remove them on the TV (Profiles, then edit, then delete) or by clearing the site's data.
- Questions, corrections or complaints: contact the household owner, who operates this app. If you are not satisfied, Indian law gives you the right to complain to the Data Protection Board of India.

## Your consent choices

Each choice is recorded separately and can be switched off at any time.

### Profiles, lesson progress and quiz answers (`learning_data`)

I agree that the app may store my children's profiles, lesson progress and quiz answers, and use them to resume lessons, schedule reviews and calculate learning scores for me.

- Needed to pair a TV, sync progress, import old progress and take quizzes.
- If this is off, TVs cannot be paired and paired TVs stop sending anything; the TV still works on its own.

### Detailed activity and on-screen time (`telemetry`)

I agree that the app may record when lessons start and end, which steps are shown and how long lessons play on screen, so that I can see time spent and scores are more accurate.

- Optional. Also needs the first choice.
- If this is off, no activity or screen-time records are kept; progress and quizzes still work.

### School syllabus uploads (`school_uploads`)

I agree that adults of my household may upload school syllabus documents so that lessons can be matched to the school's chapters.

- Optional.
- If this is off, new school documents cannot be uploaded; documents already uploaded are kept until deleted.

## Declaration

By switching a choice on, I confirm that I am the parent or lawful guardian of the children who use this app in my household, and that I agree to what is described above for that choice. The app records which adult account gave or withdrew consent, when, and for which version of this notice.

---

## Notes for the owner and the reviewer (not shown to parents)

These notes explain the drafting choices. They are not part of the consent text.

- **Approval.** The owner approved v1 on 2026-11-15 (`CONSENT_STATUS = "approved"` in `consent-text.ts`, so the portal shows
  no DRAFT banner). A future wording change starts as `"draft"` again until the owner approves it. Any change to a sentence must also change
  `CONSENT_VERSION` (for example `bnl-consent-2026-12-v2`). Parents who consented to an older version see a "please review"
  prompt; their existing consent keeps working until they withdraw it (see `docs/ops/PRIVACY.md` §3).
- **DPDP Act 2023, in plain terms.** Section 9 requires verifiable consent of a parent or lawful guardian before a child's
  personal data is processed, and rules out tracking, behavioural monitoring and targeted advertising directed at children.
  Section 6 says consent must be free, specific, informed and as easy to withdraw as to give; section 5 requires a notice of
  what is collected, the purpose, and how to exercise rights and complain to the Data Protection Board. This draft is written
  to cover those points. It does **not** certify compliance. **Recommendation: have a lawyer familiar with the DPDP Act and
  the DPDP Rules review the wording and the consent mechanism before relying on it**, especially if the app is ever offered
  outside one family.
- **How consent is "verifiable" here.** Only a signed-in owner or guardian account (email and password, rate-limited sign-in)
  can give or withdraw consent. Each grant and withdrawal is stored in `bnl.consent_records` (which adult, when, scope,
  version) and in the audit log without names. In a single-family deployment, the owner personally knows every adult account
  they invite. Whether this is enough for the Rules' verification requirement is a legal question for the reviewer.
- **Things the owner should confirm before approval:**
  1. the hosting and database providers and their data region (the text names them generically);
  2. the backup retention period (`docs/ops/BACKUP_RESTORE.md`), which the "Backups" bullet refers to;
  3. that "contact the household owner" is the right grievance contact for every adult in the household.
- **Scopes and what the code enforces** (403 `consent_required`):

  | Scope | Required by |
  |---|---|
  | `learning_data` | pairing approval, progress sync, legacy progress import, assessment start/answers/finish, telemetry |
  | `telemetry` | telemetry batches (together with `learning_data`) |
  | `school_uploads` | creating a school syllabus import (file upload) |
