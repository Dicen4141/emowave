import { createClient } from "@supabase/supabase-js";
import { prisma } from "./db";

// Shared by app/api/webhooks/quantemo-order (automatic, needs EmoWave
// deployed with a public URL Quantemo's Supabase can reach) and
// app/api/quantemo-orders (manual "+ Add to EmoSpace" button, works today
// even from localhost since it's EmoWave reaching OUT to Quantemo, not the
// other way around) — same exact logic either way, just triggered
// differently, so there's one tested path instead of two.

let cachedClient: ReturnType<typeof createClient> | null = null;
function quantemoClient() {
  if (cachedClient) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or QUANTEMO_SUPABASE_SERVICE_KEY.");
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export type QuantemoOrder = {
  id: number;
  buyer_id: number;
  product_id: number;
  status: string;
  amount_rm: number;
  created_at: string;
  shipping_address?: { full_name?: string } | null;
  // Set when the buyer named someone other than themselves at checkout —
  // Quantemo's user_family_members.id. Optional because it does not exist
  // until that feature ships; every order today arrives without it and is
  // treated as bought-for-self, exactly as before.
  subject_profile_id?: number | null;
};

// The subject's own details, read from Quantemo's family-member profile. Kept
// separate from QuantemoOrder because it comes from a different table and is
// resolved in one place (loadSubject) rather than at each call site.
export type OrderSubject = {
  profileId: number;
  name: string;
  dateOfBirth: string | null;
  relationship: string | null;
};

/**
 * Resolves who an order is FOR. Returns null when the order names nobody —
 * either because it predates family profiles or because it was bought for the
 * buyer themselves — and every caller then falls back to buyer-based
 * behaviour, which is what the whole pipeline did before subjects existed.
 *
 * A missing or unreadable profile is also null rather than an error: an order
 * that is paid for must still become a round, and staff can correct the
 * subject by hand. Refusing to process it would strand a paying customer over
 * a lookup.
 */
async function loadSubject(
  quantemo: ReturnType<typeof quantemoClient>,
  order: QuantemoOrder,
): Promise<OrderSubject | null> {
  const profileId = order.subject_profile_id;
  if (!profileId) return null;
  try {
    const { data } = await quantemo
      .from("user_family_members")
      .select("id, name, date_of_birth, relationship")
      .eq("id", profileId)
      .maybeSingle();
    const row = data as { id: number; name: string | null; date_of_birth: string | null; relationship: string | null } | null;
    if (!row?.name) return null;
    return {
      profileId: row.id,
      name: row.name.trim(),
      dateOfBirth: row.date_of_birth,
      relationship: row.relationship,
    };
  } catch {
    // The table does not exist yet on Quantemo's side — expected until that
    // migration lands, and not worth a log line on every order.
    return null;
  }
}

/**
 * Quantemo sells one product per EmoWave report, so the product's SKU is what
 * says which report was bought. Anything unrecognised falls back to the
 * overview rather than refusing the purchase — a new SKU appearing in the
 * store shouldn't strand a paying customer; staff can still send the right
 * report by hand, and the unknown SKU shows up in EmoSpace.
 */
export const REPORT_SLUG_BY_SKU: Record<string, string> = {
  "EMOWAVE-OVERVIEW": "overview",
  "EMOWAVE-FWM": "fwm",
  "EMOWAVE-CAREER": "career",
  "EMOWAVE-RELATIONSHIP": "relationship",
  // The original single product, kept live for the 14 orders placed before
  // the split. Those buyers paid for the one-page EmoWave report.
  "EM-001": "overview",
};

export function reportSlugForSku(sku: string | null): string {
  return (sku && REPORT_SLUG_BY_SKU[sku.trim().toUpperCase()]) || "overview";
}

export type ProcessOrderResult = { ok: true; assessmentId: string; created: boolean } | { ok: false; reason: string };

/**
 * Turns one paid, EmoWave-collection Quantemo order into an EmoWave
 * Client + Assessment (a "round"), or finds the one that already exists for
 * it. Idempotent on Assessment.quantemoOrderId — safe to call twice for the
 * same order (webhook redelivery, or someone clicking "Add to EmoSpace"
 * on an order that quietly got added a moment earlier).
 */
export async function processQuantemoOrder(order: QuantemoOrder): Promise<ProcessOrderResult> {
  if (order.status !== "paid") return { ok: false, reason: `status is "${order.status}", not "paid"` };

  const quantemo = quantemoClient();

  const { data: product } = await quantemo.from("products").select("collection, sku").eq("id", order.product_id).maybeSingle();
  const productRow = product as { collection: string | null; sku: string | null } | null;
  if (productRow?.collection !== "EmoWave") {
    return { ok: false, reason: "not an EmoWave product" };
  }
  const slug = reportSlugForSku(productRow.sku);

  // Idempotent on the purchase, not on the round: the same order must never
  // be recorded twice, but a DIFFERENT order for the same person is a real
  // second purchase and has to be kept.
  const existingPurchase = await prisma.reportPurchase.findUnique({
    where: { quantemoOrderId: order.id },
    select: { assessmentId: true },
  });
  if (existingPurchase) {
    return { ok: true, assessmentId: existingPurchase.assessmentId.toString(), created: false };
  }

  const { data: buyer } = await quantemo.from("users").select("uuid, email, first_name, last_name").eq("id", order.buyer_id).maybeSingle();
  const buyerRow = buyer as { uuid: string | null; email: string | null; first_name: string | null; last_name: string | null } | null;
  if (!buyerRow) return { ok: false, reason: "buyer not found in Quantemo" };

  // The round is titled with whoever it is FOR. Until a PDF is uploaded this
  // is the only name available, and showing the buyer's would file a mother's
  // report under her son in the admin queue.
  const buyerName =
    [buyerRow.first_name, buyerRow.last_name].filter(Boolean).join(" ").trim() ||
    order.shipping_address?.full_name ||
    buyerRow.email ||
    `Quantemo buyer #${order.buyer_id}`;

  // Who the report is ABOUT. Null means bought-for-self (or an order from
  // before profiles existed), in which case everything below behaves exactly
  // as it did when the buyer was always the subject.
  const subject = await loadSubject(quantemo, order);

  // A Client is now one PERSON, not one paying account. With a profile the
  // lookup is by that profile's id — exact, and stable across however many
  // times the buyer retypes a name. Without one it falls back to the buyer's
  // own row, which is deliberately narrowed to `subjectProfileId: null` so a
  // self-purchase can never attach itself to a family member's client that
  // happens to sit under the same account.
  let existingClient = subject
    ? await prisma.client.findUnique({ where: { subjectProfileId: subject.profileId } })
    : buyerRow.uuid
      ? await prisma.client.findFirst({ where: { quantemoUuid: buyerRow.uuid, subjectProfileId: null } })
      : null;

  // Migration case, and it only happens once per customer: everyone who bought
  // before family profiles existed has a Client with no profile on it. The
  // moment Quantemo starts sending a "self" profile for that same person, the
  // lookup above finds nothing and would open a SECOND client for them —
  // orphaning every round they already have behind a name that still looks
  // identical in the picker.
  //
  // So a self profile with no client yet adopts the buyer's existing
  // profile-less row instead of forking it. Restricted to "self" on purpose:
  // for a child or parent the buyer's own client is a different human, and
  // adopting it would merge two people.
  if (subject && !existingClient && subject.relationship === "self" && buyerRow.uuid) {
    const legacy = await prisma.client.findFirst({
      where: { quantemoUuid: buyerRow.uuid, subjectProfileId: null },
    });
    if (legacy) {
      existingClient = await prisma.client.update({
        where: { id: legacy.id },
        data: { subjectProfileId: subject.profileId },
      });
    }
  }

  // A second purchase attaches to the round the client already has, whether
  // or not it's been filled in yet. Buying the Financial report after the
  // overview is a request for a different report FROM THE SAME assessment
  // data — not a new sitting — so forking a fresh empty round would just
  // force staff to re-upload the same PDF. A genuinely new round is created
  // deliberately by staff at upload time ("new round"), not by a purchase.
  const currentRound = existingClient
    ? await prisma.assessment.findFirst({ where: { clientId: existingClient.id }, orderBy: { createdAt: "desc" } })
    : null;

  // Buying a DIFFERENT report attaches to the round they already have — it's
  // another report from the same assessment data, so forking a round would
  // force staff to re-upload the same PDF.
  //
  // Buying a report they've ALREADY bought on that round is the opposite:
  // nobody pays twice for a file they can re-download, so a repeat purchase
  // of the same report means they've sat the assessment again and want it
  // re-read. That gets its own round, which is what the version picker in
  // the Sources header shows as v2 — the new round starts empty and waiting
  // for the new PDF, while v1 keeps the report already delivered against it.
  const alreadyBoughtHere = currentRound
    ? await prisma.reportPurchase.count({ where: { assessmentId: currentRound.id, slug } })
    : 0;
  const targetRound = alreadyBoughtHere > 0 ? null : currentRound;

  const assessment =
    targetRound ??
    (await prisma.assessment.create({
      data: {
        customerId: subject?.name ?? buyerName,
        // Still the BUYER's address — it's who Quantemo bills and who staff
        // contact, and a family member usually has no email of their own on
        // file. The subject's identity lives in the fields below.
        customerEmail: buyerRow.email,
        // Snapshotted, not read live through the client: a report that said
        // "Mrs Lai, 68" must still say that if the profile is edited later.
        subjectName: subject?.name ?? null,
        subjectDob: subject?.dateOfBirth ? new Date(subject.dateOfBirth) : null,
        subjectRelationship: subject?.relationship ?? null,
        // Records the FIRST purchase that opened this round only.
        // report_purchases is the complete list — overwriting this on every
        // repeat purchase is exactly the bug that lost earlier orders.
        quantemoOrderId: order.id,
        status: "pending",
        client: existingClient
          ? { connect: { id: existingClient.id } }
          : { create: { quantemoUuid: buyerRow.uuid, subjectProfileId: subject?.profileId ?? null } },
      },
    }));

  await prisma.reportPurchase.create({
    data: {
      assessmentId: assessment.id,
      quantemoOrderId: order.id,
      quantemoProductId: order.product_id,
      slug,
      purchasedAt: new Date(order.created_at),
    },
  });

  // Only fill in a blank — never replace a round's original order.
  if (targetRound && targetRound.quantemoOrderId === null) {
    await prisma.assessment.update({ where: { id: targetRound.id }, data: { quantemoOrderId: order.id } });
  }

  // A PURCHASE is the third thing that can make a report deliverable, and it
  // was the missing one. Auto-delivery already fires when an upload or a copy
  // completes a round (see the EmoSpace page), which covers the customer who
  // buys before their PDFs are in. It did not cover the opposite and far more
  // common case: someone coming back weeks later to buy a second report
  // against a round that is ALREADY complete. Nothing changed about the data,
  // so nothing triggered — and the report sat undelivered indefinitely.
  //
  // Cheap in the normal case: autoDeliverPurchasedReports only renders when a
  // report is genuinely owed. An empty round is held by the gap check, and
  // anything already sent since it was bought is skipped, so the sync loop
  // pays a couple of queries per order rather than a Puppeteer render.
  //
  // Never allowed to fail the import. The purchase is recorded above and is
  // the thing that must not be lost; a delivery that fails here is picked up
  // by the next upload, copy, or a manual Deliver.
  try {
    const { autoDeliverPurchasedReports } = await import("./autoDeliver");
    const result = await autoDeliverPurchasedReports(assessment.id);
    const sent = result.outcomes.filter((o) => o.status === "sent").map((o) => o.slug);
    if (sent.length > 0) console.log(`Quantemo order ${order.id} -> auto-delivered ${sent.join(", ")} for assessment ${assessment.id}`);
  } catch (err) {
    console.error(`Auto-delivery after Quantemo order ${order.id} failed (purchase was still recorded):`, err);
  }

  return { ok: true, assessmentId: assessment.id.toString(), created: !targetRound };
}

export type EmowaveBuyerSummary = {
  buyerId: number;
  buyerName: string;
  buyerEmail: string | null;
  totalOrders: number;
  latestOrderAt: string;
  pendingOrderIds: number[]; // not yet imported — what the "Add" button acts on
  importedAssessmentIds: string[]; // already imported — link straight to these
};

/**
 * Recent paid EmoWave-collection orders, grouped by buyer (one row per
 * PERSON, not per purchase — someone who bought 5 times shows up once, with
 * a count) and cross-referenced against what's already in EmoWave. The
 * read-only list behind the Clients page's "Recent Quantemo Purchases"
 * section. Works purely by EmoWave reaching out to Quantemo, so unlike the
 * webhook this needs no public deployment to use.
 */
export async function listRecentEmowaveOrders(limit = 200): Promise<EmowaveBuyerSummary[]> {
  const quantemo = quantemoClient();

  const { data: emowaveProducts } = await quantemo.from("products").select("id").eq("collection", "EmoWave");
  const productIds = (emowaveProducts ?? []).map((p) => (p as { id: number }).id);
  if (productIds.length === 0) return [];

  const { data: orders } = await quantemo
    .from("orders")
    .select("id, buyer_id, product_id, status, amount_rm, created_at, shipping_address, subject_profile_id")
    .in("product_id", productIds)
    .eq("status", "paid")
    .order("created_at", { ascending: false })
    .limit(limit);
  const orderRows = (orders ?? []) as QuantemoOrder[];
  if (orderRows.length === 0) return [];

  const buyerIds = [...new Set(orderRows.map((o) => o.buyer_id))];
  const { data: buyers } = await quantemo.from("users").select("id, email, first_name, last_name").in("id", buyerIds);
  const buyerById = new Map((buyers ?? []).map((b) => [(b as { id: number }).id, b as { email: string | null; first_name: string | null; last_name: string | null }]));

  // "Imported" means a purchase was recorded, NOT that a round carries this
  // order id. Assessment.quantemoOrderId only ever holds the order that
  // OPENED a round, so a second purchase joining an existing round leaves it
  // untouched — checking that column alone would leave those orders showing
  // as pending forever, and re-importing them on every sync.
  const orderIds = orderRows.map((o) => o.id);
  const [purchases, existingAssessments] = await Promise.all([
    prisma.reportPurchase.findMany({
      where: { quantemoOrderId: { in: orderIds } },
      select: { assessmentId: true, quantemoOrderId: true },
    }),
    prisma.assessment.findMany({
      where: { quantemoOrderId: { in: orderIds } },
      select: { id: true, quantemoOrderId: true },
    }),
  ]);
  const assessmentByOrderId = new Map<number | null, string>(existingAssessments.map((a) => [a.quantemoOrderId, a.id.toString()]));
  for (const p of purchases) assessmentByOrderId.set(p.quantemoOrderId, p.assessmentId.toString());

  const byBuyer = new Map<number, EmowaveBuyerSummary>();
  for (const o of orderRows) {
    const buyer = buyerById.get(o.buyer_id);
    const name =
      [buyer?.first_name, buyer?.last_name].filter(Boolean).join(" ").trim() ||
      o.shipping_address?.full_name ||
      buyer?.email ||
      `Quantemo buyer #${o.buyer_id}`;
    const assessmentId = assessmentByOrderId.get(o.id) ?? null;

    const existing = byBuyer.get(o.buyer_id);
    const entry: EmowaveBuyerSummary =
      existing ??
      ({
        buyerId: o.buyer_id,
        buyerName: name,
        buyerEmail: buyer?.email ?? null,
        totalOrders: 0,
        latestOrderAt: o.created_at,
        pendingOrderIds: [],
        importedAssessmentIds: [],
      } as EmowaveBuyerSummary);
    entry.totalOrders += 1;
    if (assessmentId) entry.importedAssessmentIds.push(assessmentId);
    else entry.pendingOrderIds.push(o.id);
    byBuyer.set(o.buyer_id, entry);
  }

  // Orders already came back newest-first, so the first one seen per buyer
  // is their most recent — sorting the grouped rows the same way keeps that
  // order instead of falling back to Map insertion order.
  return [...byBuyer.values()].sort((a, b) => new Date(b.latestOrderAt).getTime() - new Date(a.latestOrderAt).getTime());
}
