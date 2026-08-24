import { createClient } from "@supabase/supabase-js";
import { prisma } from "./db";
import { renderEwFullReportHtml } from "./renderEwFullReport";
import { renderReportHtml, htmlToPdf } from "./renderReportPdf";
import { renderFwmReportHtml, fwmPdfChrome } from "./renderFwmReport";

// Pushing a finished report back to Quantemo so the person who paid for it
// can download it from their "My Reports" page. EmoWave owns three of the
// four steps — render, upload, and the row that makes it appear in the list.
// The fourth (rendering a Download button for these rows instead of running
// Quantemo's own birthday-based generator) is a change in Quantemo's app;
// until it ships, delivery still works and the file and row simply sit there.
//
// Quantemo's `reports` table has no file column — its own reports are
// generated at view time from `birthday`/`ic_number`, so there was never one.
// `payload` is jsonb, nullable and unused by those rows, so the file location
// rides there instead of requiring a migration on their side. PAYLOAD_SOURCE
// is what their page keys off to tell an EmoWave row from one of its own.
export const QUANTEMO_REPORTS_BUCKET = "reports";
export const PAYLOAD_SOURCE = "emowave";

// Their enums are `report_tier` (tier0 | tier1) and `report_variant`
// (preview | full | seeker | practitioner). Neither has an EmoWave-specific
// value; reusing the two below keeps this migration-free. The real "which
// report is this" answer is in payload.source, not in these.
const QUANTEMO_TIER = "tier0";
const QUANTEMO_VARIANT = "full";

// Only the two tables this module touches, declared so writes type-check —
// an untyped createClient() infers `never` for insert/update payloads, and
// casting them to `any` would drop the one check that catches a renamed
// column here before it fails in production. This is not their full schema.
type QuantemoDb = {
  public: {
    Tables: {
      orders: {
        Row: { id: number; buyer_id: number; product_id: number; status: string };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      reports: {
        Row: {
          id: number;
          user_id: number;
          product_id: number;
          order_id: number | null;
          tier: string;
          variant: string;
          payload: unknown;
        };
        Insert: {
          user_id: number;
          product_id: number;
          order_id?: number | null;
          tier: string;
          variant: string;
          payload?: unknown;
          // Optional both ways: the column doesn't exist on Quantemo yet, and
          // a report bought for oneself has no family profile to point at.
          subject_profile_id?: number | null;
        };
        Update: { payload?: unknown };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

let cachedClient: ReturnType<typeof createClient<QuantemoDb>> | null = null;
function quantemoClient() {
  if (cachedClient) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or QUANTEMO_SUPABASE_SERVICE_KEY.");
  cachedClient = createClient<QuantemoDb>(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export type DeliverVariant = "overview" | "full" | "fwm";
export type DeliverTheme = "career" | "relationship";
export type DeliverSpec = { variant: DeliverVariant; theme?: DeliverTheme };

/**
 * One report per file and per My Reports row. A round can be sold more than
 * one deliverable (the EmoWave overview and the Financial report are separate
 * products), so keying purely on the order would make the second delivery
 * silently replace the first. The slug is what distinguishes them.
 */
// Flipped the first time Quantemo rejects subject_profile_id, so the retry
// below happens once per process rather than on every delivery.
let subjectColumnMissing = false;

function isUnknownColumn(error: { message?: string; code?: string }, column: string): boolean {
  return error.code === "42703" || (error.message ?? "").includes(column);
}

export function deliverySlug(spec: DeliverSpec): string {
  return spec.theme ?? spec.variant;
}
export type DeliverResult =
  | { ok: true; storagePath: string; buyerId: number; created: boolean }
  | { ok: false; reason: string };

/**
 * Path is derived from the order, not from a timestamp or a random id, so
 * re-delivering a corrected report overwrites the file the customer already
 * has a link to rather than leaving two versions behind. Same reasoning as
 * the row upsert below.
 */
function storagePathFor(orderId: number, slug: string): string {
  return `${PAYLOAD_SOURCE}/${orderId}/${slug}.pdf`;
}

export async function deliverReportToQuantemo(
  assessmentId: bigint,
  spec: DeliverSpec = { variant: "overview" },
): Promise<DeliverResult> {
  const { variant, theme } = spec;
  const slug = deliverySlug(spec);
  const assessment = await prisma.assessment.findUnique({
    where: { id: assessmentId },
    include: {
      facts: true,
      stressContent: true,
      emotionalStateContent: true,
      sensoryAttributesContent: true,
      presentCharacterContent: true,
      topAttributeContent: true,
      wellnessChallengeContent: true,
      journeyOverviewContent: true,
    },
  });

  if (!assessment) return { ok: false, reason: `No assessment with id ${assessmentId}.` };
  if (assessment.facts.length === 0) return { ok: false, reason: "This round has no facts to render yet." };
  // Delivery is to the PURCHASER, so it needs the order that was paid for.
  // Rounds added by hand (no Quantemo purchase behind them) have nobody to
  // deliver to — that's a legitimate state, not an error to paper over.
  // Deliver against the order that bought THIS report, so the file path, the
  // My Reports row and the payment all line up. A round can carry several
  // purchases now, and assessment.quantemoOrderId is only the first of them —
  // using it for every report would file a Financial delivery under the
  // order that paid for the overview.
  const purchase = await prisma.reportPurchase.findFirst({
    where: { assessmentId: assessment.id, slug },
    orderBy: { purchasedAt: "asc" },
    select: { quantemoOrderId: true },
  });
  const orderId = purchase?.quantemoOrderId ?? assessment.quantemoOrderId;
  if (!orderId) {
    return { ok: false, reason: "This round isn't linked to a Quantemo order, so there's no purchaser to deliver to." };
  }

  const quantemo = quantemoClient();

  const { data: orderRow, error: orderError } = await quantemo
    .from("orders")
    .select("id, buyer_id, product_id, status")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return { ok: false, reason: `Couldn't read the Quantemo order: ${orderError.message}` };
  const order = orderRow as { id: number; buyer_id: number; product_id: number; status: string } | null;
  if (!order) return { ok: false, reason: `Quantemo order ${orderId} no longer exists.` };
  if (order.status !== "paid") return { ok: false, reason: `Order ${order.id} is "${order.status}", not paid.` };

  const hasEwFull = assessment.facts.some((f) => f.sourceReport === "iEmoWave Full");
  const hasMindReport = assessment.facts.some((f) => f.sourceReport === "Aquera Mind Report");
  // Mirrors the same guard /api/generate-report applies: the one-page
  // overview is built entirely from those two uploads' fields, so without
  // either it would render as a page of gaps rather than fail loudly.
  if (variant === "overview" && !hasEwFull && !hasMindReport) {
    return { ok: false, reason: "The one-page overview needs an iEmoWave Full or Aquera Mind Report upload for this client." };
  }

  // Same three-way branch /api/generate-report uses, so a delivered PDF is
  // byte-for-byte the report staff previewed rather than a second rendering
  // path that could drift from it.
  const html =
    variant === "fwm"
      ? await renderFwmReportHtml(assessment, false)
      : hasEwFull || hasMindReport
        ? await renderEwFullReportHtml(assessment, theme, variant)
        : renderReportHtml(assessment);
  const pdf = await htmlToPdf(html, variant === "fwm" ? fwmPdfChrome(assessment) : undefined);

  const storagePath = storagePathFor(order.id, slug);
  const { error: uploadError } = await quantemo.storage
    .from(QUANTEMO_REPORTS_BUCKET)
    .upload(storagePath, pdf, { contentType: "application/pdf", upsert: true });
  if (uploadError) {
    // storage-js collapses a 400 whose body isn't JSON to the bare statusText
    // ("Bad Request"), which says nothing about the cause. Surface the status
    // and code alongside it so the next failure is diagnosable from the UI
    // instead of needing a network-tab trace.
    const err = uploadError as { message: string; status?: number; statusCode?: string; name?: string };
    const detail = [err.status && `HTTP ${err.status}`, err.statusCode && `code ${err.statusCode}`].filter(Boolean).join(", ");
    return {
      ok: false,
      reason: `Upload of ${storagePath} to the "${QUANTEMO_REPORTS_BUCKET}" bucket failed: ${err.message}${detail ? ` (${detail})` : ""}.`,
    };
  }

  // One row per (order, report), not per delivery. Re-sending a corrected
  // EmoWave overview updates the row the customer already has; sending the
  // Financial report for the same round adds a second row beside it rather
  // than replacing the first.
  const { data: existingRow } = await quantemo
    .from("reports")
    .select("id")
    .eq("order_id", order.id)
    .eq("payload->>slug", slug)
    .maybeSingle();

  const payload = {
    source: PAYLOAD_SOURCE,
    slug,
    pdf_path: storagePath,
    bucket: QUANTEMO_REPORTS_BUCKET,
    assessment_id: assessment.id.toString(),
    variant,
    delivered_at: new Date().toISOString(),
  };

  // user_id stays the BUYER so they never lose access to something they paid
  // for. subject_profile_id is what lets the person the report is ABOUT reach
  // it from their own account once they claim their family profile — without
  // it, a report bought by a child for their mother is only ever visible to
  // the child.
  //
  // Sent defensively: the column does not exist on Quantemo's reports table
  // until that migration lands, and Postgres rejects the WHOLE insert on an
  // unknown column. A delivery must not fail over an optional link, so the
  // first rejection drops it and every later call omits it.
  // Read from the Client rather than the assessment: the profile is the
  // person's permanent identity and lives on the client row, while the
  // assessment only snapshots their name/DOB for the report's own wording.
  const subjectProfileId = assessment.clientId
    ? (await prisma.client.findUnique({ where: { id: assessment.clientId }, select: { subjectProfileId: true } }))
        ?.subjectProfileId ?? null
    : null;
  // Annotated rather than inferred: supabase-js rejects excess properties
  // against a union, so a bare ternary between "with" and "without" the
  // optional column fails to typecheck even though both halves are valid.
  type ReportInsert = QuantemoDb["public"]["Tables"]["reports"]["Insert"];
  const baseRow: ReportInsert = {
    user_id: order.buyer_id,
    product_id: order.product_id,
    order_id: order.id,
    tier: QUANTEMO_TIER,
    variant: QUANTEMO_VARIANT,
    payload,
  };

  const existingId = (existingRow as { id: number } | null)?.id ?? null;
  let rowError: { message: string } | null = null;
  if (existingId) {
    ({ error: rowError } = await quantemo.from("reports").update({ payload }).eq("id", existingId));
  } else {
    const withSubject = subjectProfileId !== null && !subjectColumnMissing;
    const row: ReportInsert = withSubject ? { ...baseRow, subject_profile_id: subjectProfileId } : baseRow;
    ({ error: rowError } = await quantemo.from("reports").insert(row));
    if (rowError && withSubject && isUnknownColumn(rowError, "subject_profile_id")) {
      subjectColumnMissing = true;
      ({ error: rowError } = await quantemo.from("reports").insert(baseRow));
    }
  }
  if (rowError) return { ok: false, reason: `Couldn't write the Quantemo reports row: ${rowError.message}` };

  // EmoWave's own record of what the customer actually received. Kept in step
  // with the row above rather than appended to, for the same reason.
  const alreadyDelivered = await prisma.generatedReport.findFirst({
    where: { assessmentId: assessment.id, variant: slug, delivered: true },
  });
  if (alreadyDelivered) {
    await prisma.generatedReport.update({
      where: { id: alreadyDelivered.id },
      data: { storagePath, generatedAt: new Date() },
    });
  } else {
    await prisma.generatedReport.create({
      data: { assessmentId: assessment.id, variant: slug, storagePath, delivered: true },
    });
  }

  return { ok: true, storagePath, buyerId: order.buyer_id, created: !existingId };
}
