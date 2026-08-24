# EmoWave — Go-Live Runbook

Status of the codebase as audited on 2026-08-20, in `c:\ecowave`.

Steps 1–3 are hard blockers: the app cannot be deployed correctly until they are
done. Steps 4–11 are configuration and can be worked in order after that.

---

## Blocker 1 — The production build currently fails

`npx next build` compiles, then dies on two type errors.

**`app/api/generate-report/route.ts:124`** — `htmlToPdf` returns a Node `Buffer`,
which Next 15 no longer accepts as a `NextResponse` body:

```ts
return new NextResponse(new Uint8Array(pdf), { headers: { ... } });
```

**`lib/renderReportPdf.ts:353`** — Puppeteer 25 narrowed `setContent`'s
`waitUntil` to `load | domcontentloaded`:

```ts
await page.setContent(html, { waitUntil: "load" });
```

Safe here: the comment directly below it already notes the fonts are base64 data
URIs, not network requests, so `document.fonts.ready` is the real gate.

Do **not** paper over these with `typescript.ignoreBuildErrors` — the first one
is a genuine runtime break on PDF download.

---

## Blocker 2 — Pick a host that can run Chromium. Not Vercel.

Three things in the code rule out serverless functions:

- `lib/renderReportPdf.ts:350` calls `puppeteer.launch()` against the full
  bundled Chromium (~170 MB) — over Vercel's lambda size limit.
- `lib/saveText.ts:7`, `lib/makePdf.ts:162` and both extract routes write into
  `process.cwd()/extractions`. That path is read-only on serverless, so
  `app/api/extract/route.ts:120` would throw `EROFS` on every upload.
- Gemini extraction plus a multi-page Puppeteer render regularly outruns
  serverless execution caps.

Deploy as a **long-running Node container** — Railway, Render, Fly.io, or a
plain VPS with Docker.

The Dockerfile needs:

- Chromium system libraries. On Debian/Ubuntu:
  `libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 fonts-liberation`
- A `--no-sandbox` launch arg if the process runs as root.
- A persistent volume mounted at `/app/extractions` if the debug dumps are
  worth keeping.
- Node 24, to match local `v24.18.0`. Add to `package.json`:
  `"engines": { "node": ">=24" }`

---

## Blocker 3 — Two routes are open to the entire internet

`middleware.ts:85` matches only `/admin`, `/admin/:path*` and `/api/:path*`.
That leaves two routes unauthenticated:

- **`/report/[id]`** (`app/report/[id]/route.ts`) renders a client's full
  psychological report, and `Assessment.id` is `BigInt @default(autoincrement())`
  (`prisma/schema.prisma:66`). Anyone can walk `/report/1`, `/report/2`, … and
  read every client on file. Invisible on localhost; a data breach on day one of
  a public domain.
- **`/studio/[kind]/[assessmentId]`** (`app/studio/[kind]/[assessmentId]/route.ts`)
  accepts `?refresh=true` and calls Gemini (`lib/studioArtifacts.ts:235`) —
  unauthenticated, uncapped spend on the API key.

**Fix:** add both to the middleware matcher. Delivery already goes through
Quantemo Storage rather than these links; `/report/[id]` is only linked from
staff UI (`app/admin/reports/page.tsx:284`) and the Studio page is iframed from
the authenticated workspace, so gating them costs nothing.

If clients should later open a report link directly, add a random `share_token`
column and look it up by that instead of by sequential id.

---

## 4. Version control

`c:\ecowave` is not a git repo. Every host deploys from one, and without it
there is no rollback.

```powershell
git init
git add -A
git commit -m "EmoWave: initial commit"
```

`.gitignore` already excludes `.env*` and `/extractions` — verified.

---

## 5. Production environment variables

Set all eight the code actually reads:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Transaction-mode pooler (app queries) |
| `DIRECT_URL` | Session-mode pooler (migrations) |
| `GEMINI_API_KEY` | |
| `NEXT_PUBLIC_SUPABASE_URL` | |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | |
| `QUANTEMO_SUPABASE_SERVICE_KEY` | Server-only. Never prefix `NEXT_PUBLIC_` |
| `QUANTEMO_WEBHOOK_SECRET` | Must match the webhook header in step 8 |
| `NEXT_PUBLIC_SITE_URL` | Real domain — see below |

`NEXT_PUBLIC_SITE_URL` is read by `scripts/create-admin.mjs:70` to build the
set-password invite link. If it isn't the production domain, staff invites point
at localhost.

These keys have been sitting in a local `.env.local` throughout development —
**rotate the Gemini key and the Supabase service-role key** as they move to
production.

---

## 6. Database — verify, do not re-push

The data is already live in Supabase Postgres.

> **Never run `prisma db push` against this database.** Quantemo's own tables
> share it and are not in `prisma/schema.prisma`, so a push would try to drop
> them. This is called out at `supabase/003_clients_rounds_reports.sql:12`.

Apply any pending SQL by hand in the Supabase SQL Editor, then run
`npx prisma generate` only (generate, not push). The `postinstall` hook already
does this on deploy, which is correct.

Housekeeping: delete the dead `Document` and `Row` models
(`prisma/schema.prisma:14-30`), left over from the PDF-extractor era.

---

## 7. Create admin accounts on the live URL

```powershell
node scripts/create-admin.mjs <email> superadmin
```

Run with `NEXT_PUBLIC_SITE_URL` pointing at production, so the invite lands on
the right `/admin/set-password`.

---

## 8. Switch order intake from polling to the webhook

This is the main capability deployment unlocks.

Stop `scripts/poll-quantemo-orders.mjs` — it was the localhost workaround and
its own header says to retire it once deployed.

In **Quantemo's** Supabase project → **Database → Webhooks → Create**:

- Table: `orders`
- Events: Insert, Update
- Type: HTTP Request → POST
- URL: `https://<your-domain>/api/webhooks/quantemo-order`
- Header: `x-webhook-secret` = the value of `QUANTEMO_WEBHOOK_SECRET`

Full setup notes are at the bottom of
`app/api/webhooks/quantemo-order/route.ts:50`.

Test with a real pending → paid order **before** retiring the poller. Keep the
manual "+ Add to Workspace" button as the fallback path.

---

## 9. Confirm Quantemo Storage write access

`lib/quantemoDelivery.ts:192` uploads the PDF to the reports bucket and inserts
a `reports` row using the service key.

Verify against the production project that the bucket exists and the service key
can `upsert` into it. This is the last step of every fulfilment and the one that
fails in front of a paying customer.

---

## 10. Decide on email

Resend is a dependency but wired to nothing real. Only
`app/api/test-email/route.ts` calls `sendReportReadyEmail`, and `RESEND_API_KEY`
is commented out in `.env.local`. Report delivery happens inside Quantemo.

Pick one:

- **Delete** `app/api/test-email/route.ts` (its own comment says that's safe), or
- **Wire it up**: verify a sending domain in Resend, set `RESEND_API_KEY` and
  `RESEND_FROM_ADDRESS`, and call it from the delivery flow.

Do not ship it half-connected.

---

## 11. Smoke test on the live domain

In this order:

1. Sign in as an admin.
2. Upload a PDF at `/admin/extract`.
3. Confirm the extracted facts land.
4. Generate every report variant — overview / full / fwm, both themes — and
   check each PDF renders with the correct fonts. Chromium-in-a-container is
   exactly where font fallback bites, and the failure is silent.
5. Deliver to a test Quantemo account.
6. Confirm the file appears in that account.
7. Place a real test order and watch the webhook auto-import it.

---

## Post-launch

- **Backups** — confirm Supabase point-in-time recovery is on for the plan in use.
- **Logs** — container stdout only, today. `console.error` in the API routes is
  the whole error trail; consider shipping it somewhere durable.
- **Cost guard** — set a quota/alert on the Gemini key. Report generation and
  every Studio artifact are model calls.
- **README** — `README.md` still documents the original SQLite PDF-extractor and
  describes an app that no longer exists. Rewrite it before onboarding anyone.
