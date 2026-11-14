# ADR-0006: Deployment topology — one origin, admin at /admin

- Status: Accepted as default (2026-11-14); owner may switch to a separate admin project later.

## Decision
- `apps/admin` is a Next.js App Router app that serves `/admin/**` (adult UI) and `/api/v1/**` (BFF). At build time it copies the student app's static output into its `public/`, so **one** Vercel project serves `/` (student, unchanged URLs), `/admin` and `/api/v1` on `breaknlearn.vercel.app`.
- Until the owner approves cutover (P7), the existing Vercel project is untouched. Development and staging use a **separate** Vercel preview project/environment and a separate Supabase project.
- Student assets keep their current paths (`/`, `/logo.webp`, `/music.wav`) so bookmarks and TV home-screen shortcuts keep working.
- Admin responses: `Cache-Control: no-store`, strict CSP, `X-Frame-Options: DENY`; catalog responses: `public, max-age=60, stale-while-revalidate` with ETag.

## Alternatives
- Separate `breaknlearn-admin.vercel.app` project: acceptable later; needs CORS for the API or a second API deployment. `admin.breaknlearn.vercel.app` is not assignable on vercel.app and is rejected.
