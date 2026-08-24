# EmoWave — How It Works, Step by Step

The whole system is one internal admin tool. There is no public-facing app:
`next.config.mjs` redirects `/` straight to `/admin`, and `middleware.ts` gates
every page and API route behind a signed-in Supabase account with an
`admin`/`superadmin` role.

The job it does, end to end: **a customer buys a report on Quantemo → staff
upload that person's raw vendor PDFs → the app extracts the data → it renders a
finished report → the report is delivered back into the customer's Quantemo
account.**

---

## The two databases (read this first)

Nothing else makes sense without this. There are **two separate Supabase
projects**, and the app talks to both:

| | What lives there | How the app reaches it |
| --- | --- | --- |
| **Quantemo's project** | Customers (`users`), family profiles, `orders`, `products`, and the `reports` the customer sees in their account | Supabase JS client with the **service-role key** (`lib/quantemo.ts`, `lib/quantemoOrders.ts`) |
| **EmoWave's project** | `clients`, `assessments`, `report_facts`, generated content, the vendor reference tables | **Prisma** (`DATABASE_URL`, `prisma/schema.prisma`) |

EmoWave deliberately does **not** copy customer names, emails or ages into its
own database — it reads them live from Quantemo. That is why an assessment
stores only a snapshot (`ageAtAssessment`, `subjectName`) taken at generation
time: a report that said "age 42" must still say 42 when reopened next year.

Also worth knowing up front: Quantemo's Supabase Auth is the **same** project
used to sign staff in. An admin account is just a Quantemo account with
`role: admin` set in `app_metadata`, which can only be written server-side with
the service-role key (`scripts/create-admin.mjs`).

---

## Step 1 — A customer places an order on Quantemo

The customer buys an EmoWave product in Quantemo's own storefront. EmoWave has
no part in this; a row simply appears in Quantemo's `orders` table.

An order carries a `buyer_id` (who paid) and, optionally, a
`subject_profile_id` (who the report is *for*, when the buyer named a family
member at checkout).

## Step 2 — The order becomes a round in EmoWave

`processQuantemoOrder()` in `lib/quantemoOrders.ts` is the single entry point.
It runs in three checks, in order:

1. **Is it paid?** `status !== "paid"` is skipped. Orders are usually created
   pending and updated later, which is why both events matter.
2. **Is it ours?** The product's `collection` must be `EmoWave`. The `sku` then
   decides *which* report was bought (`reportSlugForSku`).
3. **Have we seen it?** Lookup by `quantemoOrderId`. The same order is never
   recorded twice — but a *different* order for the same person is a genuine
   second purchase and is kept.

It then resolves **who the round is about**:

- With a `subject_profile_id`, the person is looked up in Quantemo's family
  profiles and matched to a `Client` by `subjectProfileId` — exact, and stable
  no matter how the buyer retypes the name.
- Without one, it falls back to the buyer's own `Client`, narrowed to
  `subjectProfileId: null` so a self-purchase can never attach itself to a
  family member's record under the same account.

The result is a **`Client`** (one person) and a new **`Assessment`** (one
round — one purchase). A client who buys again gets a *new* assessment rather
than overwriting the old one, which is what keeps past reports reissuable.

### Two ways this gets triggered

| Path | When it runs | Requires |
| --- | --- | --- |
| **Webhook** — `app/api/webhooks/quantemo-order` | Automatically, the moment the order is paid | EmoWave deployed at a public URL Quantemo's Supabase can reach. Authenticated by the `x-webhook-secret` header, since there's no admin session on a server-to-server call |
| **Manual** — "+ Add to Workspace" on `/admin/clients` | When staff click it | Nothing. Works from localhost, because it's EmoWave reaching *out* to Quantemo |

Both call the exact same function, so there's one tested path, not two. A third
option, `scripts/poll-quantemo-orders.mjs`, runs the manual path on a 1-minute
timer — the pre-deployment stand-in for the webhook.

## Step 3 — Staff upload the raw vendor PDFs

This happens in the **Workspace** (`/admin/workspace`), or on the standalone
Extract page (`/admin/extract`), which does the same thing.

The client is sent three PDFs per person by the vendor, and the app
auto-detects which is which by reading page 1
(`lib/extractTemplateFacts.ts:831`):

- **iEmoWave Full**
- **Aquera Mind Report**
- **Emotional Notes**

Multiple files can be uploaded in one batch. Because the same person's name is
often spelled differently across report types — a confirmed real case,
"Nassirdeen Yahaya" on one and "Nassirdeen Yahaya Kwande" on another —
`namesLikelySamePerson()` does a **word-by-word prefix** match so the three
files land on one client instead of forking into three. It is deliberately
scoped to the "is this the client I already have open" check only; a general
fuzzy search across all clients would risk merging two different people who
share a first name.

## Step 4 — Extraction turns a PDF into facts

`POST /api/extract-facts` → `extractTemplateFacts()` reads the PDF with
`pdfjs-dist`. Three different techniques, depending on what the vendor did:

- **Selectable text** — read directly out of the PDF.
- **Position-based extraction** — for the fixed-layout iEmoWave Full template,
  values are read by *where they sit on the page*, not by matching labels.
- **Gemini Vision** — the Emotional Notes "Note Balance" chart has its numbers
  baked into image pixels with no selectable text. There's no OCR library in
  the project, so the image is decoded, re-encoded as a PNG (zlib only, no
  `canvas` dependency) and sent to Gemini to read out.

Some fields are also **paraphrased** by Gemini (`lib/paraphrase.ts`) rather than
copied verbatim.

Output is a set of `ReportFact` rows — `section`, `label`, `value`,
`sourceReport` — attached to the assessment. A plain-text dump of every
extraction is also written to `/extractions` for debugging.

> **Circled answers** are handled separately by `/api/extract-circles`
> (`lib/extractCircled.ts`) — some vendor pages record answers as hand-drawn
> circles rather than text.

## Step 5 — Staff review and correct the facts

`/admin/facts` lists what was extracted and lets staff edit it. Every fact
records whether it was read from the document or produced by a model call, so a
wrong value can be traced to which of the two put it there.

`lib/reportGapCheck.ts` flags what's missing before it becomes a hole in the
finished report — e.g. *"Behaviour Pattern: no Note 1/Note 2 — wheel and note
scale won't be marked for this client."*

## Step 6 — Generating a report

`GET /api/generate-report?assessmentId=…&variant=…&theme=…`

Three **variants**, each with its own renderer:

| Variant | Renderer | Notes |
| --- | --- | --- |
| `full` | `lib/renderEwFullReport.ts` | The multi-page iEmoWave report. Takes a `theme`: `career` or `relationship` |
| `overview` | `lib/renderOverviewSvg.ts` | One page. Fills the vendor's own SVG template (`public/report-templates/emowave-overview.svg`) with this client's values |
| `fwm` | `lib/renderFwmReport.ts` | Financial Wealth Management — a separate report *type* with its own vendor reference tables. Ignores `theme` entirely |

Each renderer produces a complete HTML document, which `htmlToPdf()`
(`lib/renderReportPdf.ts`) prints through headless Chromium via Puppeteer.

Two things the renderers depend on:

- **Reference tables** — the vendor's spreadsheets, imported into `*_reference`
  and `fwm_*` tables by `scripts/import-reference-data.mjs`. The report looks up
  a client's character number, note pair or stress score in these to get the
  paragraph that belongs to it. Superadmins can edit them at
  `/admin/reference-data`.
- **Cached AI copy** — FWM's opening overview is composed once per round and
  stored, so every download reissues the same words. `?refresh=1` replaces a bad
  first result.

Guard rails: an `overview` or `fwm` request for a client with neither an
iEmoWave Full nor an Aquera Mind Report upload returns **422** with the reason,
rather than rendering a page of gaps.

## Step 7 — Delivery to the customer

`POST /api/deliver-report` → `deliverReportToQuantemo()`
(`lib/quantemoDelivery.ts`). This is the one route that writes into a
*customer's* account rather than EmoWave's own data, so it stays an explicit
staff action — it never fires automatically when a round is processed.

It:

1. Renders the PDF for the requested variant.
2. Uploads it to Quantemo's Storage bucket.
3. Inserts a row in Quantemo's `reports` table, which is what makes it appear
   in the customer's account.
4. Marks the `GeneratedReport` row `delivered`.

**Double-send guard:** a second delivery of the same variant returns **409**
rather than re-sending. The one exception is a purchase made *after* the last
delivery — that's a customer paying for the report a second time, so they're
owed a fresh copy, and it goes through. A genuine correction still works, but
has to be asked for explicitly with `resend: true`.

---

## The extra tools in the Workspace

These sit alongside the main pipeline and all read the same client data:

- **Chat** (`/api/workspace/[id]/chat`) — ask questions about a client; grounded
  in their extracted facts.
- **Studio** (`/studio/[kind]/[assessmentId]`) — five Gemini-generated
  deliverables from the same data: Slide Deck, Flashcards, Quiz, Infographic,
  Data Table. Rendered as standalone HTML and iframed into the Studio modal.
- **Mind Map** (`/admin/mind-map/[assessmentId]`) — an SVG tree of the client's
  profile.
- **Notes** (`/api/notes`) — staff notes against a round.

Every one of these follows the same rule as the report renderers: **grounded in
the client's real data, never invented.** `lib/mindMap.ts` returns `null` on
failure rather than a fabricated map, and the Studio renders a visible error
card in the frame rather than a blank panel.

---

## The whole flow at a glance

```
Quantemo order (paid, collection=EmoWave)
        │
        ├─ webhook  /api/webhooks/quantemo-order      (auto, needs public URL)
        └─ manual   "+ Add to Workspace"              (works anywhere)
        │
        ▼
processQuantemoOrder()  →  Client (a person) + Assessment (a round)
        │
        ▼
Staff upload 3 vendor PDFs        /admin/workspace
        │
        ▼
extractTemplateFacts()            pdfjs · position-based · Gemini Vision
        │                         → ReportFact rows + /extractions dump
        ▼
Staff review / correct            /admin/facts  + reportGapCheck warnings
        │
        ▼
Render                            full · overview · fwm
        │                         + vendor reference tables
        │                         → HTML → Puppeteer → PDF
        ▼
Deliver                           upload to Quantemo Storage
                                  + insert Quantemo `reports` row
                                  → appears in the customer's account
```

---

## Where the outside services fit

| Service | Used for | Key |
| --- | --- | --- |
| **Gemini** | Paraphrasing facts, reading the Note Balance chart, FWM overview copy, Studio artifacts, Mind Map, Chat | `GEMINI_API_KEY` |
| **Supabase (Quantemo)** | Staff auth, customer/order lookup, report delivery, Storage | `NEXT_PUBLIC_SUPABASE_*`, `QUANTEMO_SUPABASE_SERVICE_KEY` |
| **Supabase (EmoWave)** | The app's own database, via Prisma | `DATABASE_URL`, `DIRECT_URL` |
| **Puppeteer** | HTML → PDF for every report | — |
| **Resend** | Email. **Not wired to anything real** — only `/api/test-email` calls it, since delivery happens inside Quantemo | `RESEND_API_KEY` |

For deployment steps, see `GO-LIVE.md`.
