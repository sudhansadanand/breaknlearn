# P7 owner checklist (go-live approval)

Nothing in P7 starts until every box is ticked and the owner has signed §7. Store all values in the Vercel or
Supabase secret stores. **Never** put them in the repo, a ticket, chat or this file. In this file, write only "done"
plus where the value is stored.

## 1. Supabase project
- [ ] Production project created (region: ________). The plan includes backups. PITR: yes/no. Backup retention: ____ days.
- [ ] Separate staging project created, holding no real child data.
- [ ] Auth: public sign-ups off; site and redirect URLs set; email templates reviewed.
- [ ] `bnl` is not in the exposed API schemas.
- [ ] Migrations 0001–0008 and the core seeds applied to staging, then production (`DEPLOYMENT_RUNBOOK.md` §2). Verification queries returned 0 rows.
- [ ] `bnl_app` password generated and stored. Private bucket `school-syllabi` created (§4).

## 2. People and access
- [ ] Owner admin email: admin email provided by owner 2026-11-15, bootstrap with scripts/ops/bootstrap-owner.mjs (`DEPLOYMENT_RUNBOOK.md` §5: one-time password delivered out of band, forced change at first sign-in). Do not write the address here.
- [ ] Who else gets household (guardian) access: ________.
- [ ] Who gets staff roles (editor/reviewer/publisher/analyst), if anyone: ________.
- [ ] Who holds Vercel and Supabase admin access, and how it is protected (2FA).

## 3. Domain
- [ ] Production origin: `https://breaknlearn.vercel.app` (unchanged), or a custom domain: ________ (DNS owner confirmed).
- [ ] `APP_ORIGIN` and `ADMIN_ORIGIN` set to it.

## 4. Privacy decisions (`PRIVACY.md`)
- [ ] Retention confirmed: raw telemetry ____ days (default 90), aggregates ____ days (default 395), audit log ____ days.
- [ ] Consent text and version string approved; consent recorded before the first TV is paired.
- [ ] Applicable law and the parental-consent approach confirmed (e.g. DPDP Act 2023).
- [ ] Deletion and export requests: who runs the interim procedure, target of 7 days.
- [ ] External households allowed? yes/no. If yes, a privacy notice is needed first.

## 5. Rollback readiness (`ROLLBACK.md`)
- [ ] **Current production Vercel deployment id** (the legacy app) recorded: `dpl_________________`. It is confirmed to serve the bytes in `legacy/live-snapshot-2026-11-14`.
- [ ] Who can promote it, and how fast.
- [ ] Emergency `sw.js` prepared (`apps/student/README.md`).

## 6. Pre-flight evidence
- [ ] P6 gate run on the release commit (A9 report): all green, red-team passing, rollback and backup rehearsals passing.
- [ ] Open findings accepted or fixed: A9-SEC-01 (migration 0008), A9-OPS-01 (flag enforcement), residual risks R1–R7 (`docs/security/SECURITY_REVIEW.md`).
- [ ] LG TV checklist passed on staging (`LG_TV_TEST_PLAN.md`), with model and webOS version recorded.
- [ ] Monitoring and alert recipients chosen (`MONITORING.md`). Job scheduler chosen (`DEPLOYMENT_RUNBOOK.md` §7).

## 7. Written approval

> I approve deploying commit `________` of BreakNLearn to production on `________`, following DEPLOYMENT_RUNBOOK.md
> with feature flags enabled in the documented order, and I accept the residual risks listed in SECURITY_REVIEW.md.

Owner name: ______________________  Signature/email confirmation: ______________________  Date: __________
