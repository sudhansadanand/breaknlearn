# BreakNLearn Engineering Handoff — CMS, Telemetry & Learning Intelligence

## What this bundle is
An implementation-ready **specification and contracts package**, NOT a fully implemented CMS or deployed admin. Hand this entire ZIP to your AI coding agent or place it at the root of a fresh project workspace, then give the agent the prompt below. It specifies the existing Vercel student app, the curriculum seed, database models, APIs, security/analytics requirements and concurrent development plan.

## Start here
1. `agents/AGENTS.md` — lead agent orchestration and hard rules.
2. `spec/00_MASTER_IMPLEMENTATION_SPEC.md` — module-by-module functional + nonfunctional specification, inputs/outputs, runtime location and maintenance.
3. `agents/WORK_BREAKDOWN.yaml` — parallel dependency DAG and release gates.
4. `contracts/contracts.openapi.yaml`, `contracts/telemetry.schema.json`, `contracts/example_lesson_v1.json` — shared interfaces.
5. `db/001_schema_blueprint.sql` — database starting blueprint, **must be reviewed and completed**, not assumed production-ready.
6. `testing/ACCEPTANCE_MATRIX.md` — testable behavior/security requirements.
7. `operations/DEPLOYMENT_AND_MAINTENANCE.md` — production/rollback/runbook.
8. `reference/curriculum_seed_prototype.json` and visual PDF — initial curriculum editorial topics and visual rules.

## Copy/paste prompt to coding agent

> You are the lead implementation agent for BreakNLearn. Read `agents/AGENTS.md` and the entire engineering handoff. Implement the **complete deployable codebase** according to the master specification. First inventory the actual existing BreakNLearn application/Vercel project, freeze schemas/contracts, then spawn independent agents by ownership and dependency graph. Implement the CMS, verified curriculum workflow, school syllabus mapping, secure database/authentication, publishing API, student integration with legacy data migration, telemetry/offline queue, assessments, ELS engine, parent/admin analytics and operations. Run automated and security tests, produce proof of completion, and prepare staging deployment. Never expose child data, never publish unreviewed topics, never make production changes or assume credentials without explicit authorization. If external access is blocked, deliver fully runnable local code with `.env.example`, mock test data and exact setup steps rather than inventing success.

## Status
As of 2026-11-14 this package is an engineering specification only. Student app is the known live app; CMS, central telemetry, scoring and secure admin are target architecture and need coding/deployment.
