import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Every paid Quantemo order, newest first, each tagged with whether the report
 * it bought has actually been sent back. This is the admin dashboard's working
 * queue — "who paid today, and who is still owed a report" — which the recent-
 * assessments list it replaced could not answer: an assessment exists whether
 * or not anyone bought anything, and says nothing about fulfilment.
 *
 * A purchase is fulfilled when a GeneratedReport for the same round carries
 * `delivered` and a `variant` equal to the purchase's `slug` — the same match
 * POST /api/deliver-report makes before it refuses a double-send, so this list
 * can never disagree with what that endpoint will allow.
 *
 * Query: ?q=&status=&slug=&page=&pageSize=
 */
export type PurchaseStatus = "pending" | "sent" | "resend";

export type PurchaseRow = {
  orderId: number;
  assessmentId: string;
  customerId: string;
  customerEmail: string | null;
  slug: string;
  purchasedAt: string;
  status: PurchaseStatus;
  deliveredAt: string | null;
  // Who the report is ABOUT, when that isn't the buyer. Null on every order
  // placed before family profiles existed, which staff read as bought-for-self.
  subjectName: string | null;
  subjectRelationship: string | null;
};

// Every order is loaded and tagged on each request, then searched, filtered
// and paged in memory. Status is the reason: it's derived from a join against
// delivered reports, so it doesn't exist until the rows are in hand and can't
// be a WHERE clause. Doing the text search in the same pass keeps the header
// counts describing ALL orders rather than whatever is currently typed in the
// search box. Bounded so a runaway table can't turn one page view into an
// unbounded scan — if orders ever approach this, status belongs in a stored
// column and all of this becomes a real query.
const MAX_SCAN = 5000;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const statusFilter = params.get("status") ?? "";
  const slugFilter = params.get("slug") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get("pageSize")) || 10));

  const purchases = await prisma.reportPurchase.findMany({
    orderBy: { purchasedAt: "desc" },
    take: MAX_SCAN,
    select: {
      quantemoOrderId: true,
      assessmentId: true,
      slug: true,
      purchasedAt: true,
      assessment: {
        select: {
          customerId: true,
          customerEmail: true,
          subjectName: true,
          subjectRelationship: true,
        },
      },
    },
  });

  // One query for every delivery on the rounds in play, rather than a lookup
  // per purchase.
  const deliveries = await prisma.generatedReport.findMany({
    where: { assessmentId: { in: purchases.map((p) => p.assessmentId) }, delivered: true },
    select: { assessmentId: true, variant: true, generatedAt: true },
    orderBy: { generatedAt: "desc" },
  });
  // Newest first above, so the first write per key is the latest delivery.
  const latestDelivery = new Map<string, Date>();
  for (const d of deliveries) {
    const key = `${d.assessmentId}|${d.variant}`;
    if (!latestDelivery.has(key)) latestDelivery.set(key, d.generatedAt);
  }

  const all: PurchaseRow[] = purchases.map((p) => {
    const deliveredAt = latestDelivery.get(`${p.assessmentId}|${p.slug}`) ?? null;
    // Buying again after the last delivery means they've paid a second time
    // and are owed a fresh copy — surfaced as its own state rather than
    // "sent", which would leave a paid order looking handled.
    const status: PurchaseStatus = !deliveredAt ? "pending" : p.purchasedAt > deliveredAt ? "resend" : "sent";
    return {
      orderId: p.quantemoOrderId,
      assessmentId: String(p.assessmentId),
      // customerId is already the subject's name for profile-backed orders
      // (processQuantemoOrder titles the round with whoever it's for), so this
      // stays the display name and the fields below add the relationship.
      customerId: p.assessment.customerId,
      subjectName: p.assessment.subjectName,
      subjectRelationship: p.assessment.subjectRelationship,
      customerEmail: p.assessment.customerEmail,
      slug: p.slug,
      purchasedAt: p.purchasedAt.toISOString(),
      status,
      deliveredAt: deliveredAt?.toISOString() ?? null,
    };
  });

  // Name, email and order number all in one box — staff have whichever of the
  // three the customer quoted at them, and shouldn't have to pick a field.
  const filtered = all.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (slugFilter && r.slug !== slugFilter) return false;
    if (!q) return true;
    return (
      r.customerId.toLowerCase().includes(q) ||
      (r.subjectName ?? "").toLowerCase().includes(q) ||
      (r.customerEmail ?? "").toLowerCase().includes(q) ||
      String(r.orderId).includes(q)
    );
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Narrowing a search can strand the caller on a page that no longer exists —
  // clamp rather than answering with an empty list while rows are available.
  const safePage = Math.min(page, totalPages);
  const rows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Midnight local time — "today" means the working day staff are looking at,
  // not a rolling 24 hours.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  return NextResponse.json({
    purchases: rows,
    page: safePage,
    pageSize,
    totalPages,
    totalMatching: filtered.length,
    // Deliberately computed over ALL orders, not the current search, so the
    // header stays a standing backlog figure instead of shifting as someone
    // types.
    summary: {
      total: all.length,
      today: all.filter((r) => new Date(r.purchasedAt) >= startOfToday).length,
      pending: all.filter((r) => r.status === "pending").length,
      resend: all.filter((r) => r.status === "resend").length,
      sent: all.filter((r) => r.status === "sent").length,
    },
    // Only the report types that actually appear, so the category filter never
    // offers something that returns nothing.
    slugs: [...new Set(all.map((r) => r.slug))].sort(),
  });
}
