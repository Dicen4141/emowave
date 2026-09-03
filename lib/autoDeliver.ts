import { prisma } from "@/lib/db";
import { checkReportGaps } from "@/lib/reportGapCheck";
import { deliverReportToQuantemo, deliverySlug, type DeliverSpec } from "@/lib/quantemoDelivery";

/**
 * Turns a purchase slug back into the render spec that produces it.
 * deliverySlug() is `theme ?? variant`, so this is its inverse — "career"
 * and "relationship" are themed EmoWave reports rather than variants of
 * their own, which is why they can't be passed straight through as one.
 *
 * An unrecognised slug returns null rather than falling back to the
 * overview. reportSlugForSku() already falls back for an unknown SKU, and
 * guessing a second time here would mean automatically sending a customer a
 * report nobody established they bought — the one thing this whole feature
 * is supposed not to do. Staff still send those by hand.
 */
function specForSlug(slug: string): DeliverSpec | null {
  switch (slug) {
    case "overview":
      return { variant: "overview" };
    case "full":
      return { variant: "full" };
    case "fwm":
      return { variant: "fwm" };
    case "career":
      return { variant: "full", theme: "career" };
    case "relationship":
      return { variant: "full", theme: "relationship" };
    default:
      return null;
  }
}

export type AutoDeliverOutcome =
  | { slug: string; status: "sent"; storagePath: string; created: boolean }
  | { slug: string; status: "skipped" | "failed"; reason: string };

export type AutoDeliverResult = {
  // False only when nothing was attempted at all — no purchases on file, or
  // the round still has gaps. The per-report outcomes carry their own status.
  attempted: boolean;
  reason?: string;
  warnings: string[];
  outcomes: AutoDeliverOutcome[];
};

/**
 * Sends every report this round's customer has PAID FOR and not yet
 * received, without a staff click — the automatic counterpart to the
 * Deliver button in EmoSpace (app/api/deliver-report).
 *
 * Two rules keep this from being the thing the manual route was deliberately
 * protecting against (see the comment at the top of that route):
 *
 *   1. Purchases drive it. The list of what to send comes from ReportPurchase
 *      rows, never from what happens to be renderable. A customer who bought
 *      the overview gets the overview and nothing else; a round with no
 *      purchases on file sends nothing at all. Goodwill copies and
 *      mis-ordered products stay a human decision.
 *
 *   2. Gaps stop it. checkReportGaps() is the same pass the preview's warning
 *      banner uses. If any section would render empty, this refuses the whole
 *      round and leaves it for staff — an automatic send is exactly when
 *      nobody is looking at the PDF, so "renders empty" must not reach a
 *      paying customer. Uploading the missing source and re-running clears it.
 */
export async function autoDeliverPurchasedReports(assessmentId: bigint): Promise<AutoDeliverResult> {
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
  if (!assessment) {
    return { attempted: false, reason: `No assessment with id ${assessmentId}.`, warnings: [], outcomes: [] };
  }

  const purchases = await prisma.reportPurchase.findMany({
    where: { assessmentId },
    select: { slug: true, purchasedAt: true },
    orderBy: { purchasedAt: "asc" },
  });
  // Checked before the gap check on purpose: a round nobody bought anything
  // for isn't "not ready yet", it's simply not this function's business, and
  // reporting it as a gap would put a warning in front of staff for a round
  // that needs no action.
  if (purchases.length === 0) {
    return { attempted: false, reason: "No purchases on file for this round.", warnings: [], outcomes: [] };
  }

  const warnings = checkReportGaps(assessment);
  if (warnings.length > 0) {
    return {
      attempted: false,
      reason: "Held back — this round still has gaps, so it needs a look before it goes out.",
      warnings,
      outcomes: [],
    };
  }

  const delivered = await prisma.generatedReport.findMany({
    where: { assessmentId, delivered: true },
    select: { variant: true, generatedAt: true },
  });
  // Latest send per slug — the same comparison tileState() makes in the
  // EmoSpace UI. "Has it ever been sent" isn't enough: a customer who buys
  // the same report a second time is owed a fresh copy.
  const lastSentFor = new Map<string, Date>();
  for (const d of delivered) {
    const prev = lastSentFor.get(d.variant);
    if (!prev || d.generatedAt > prev) lastSentFor.set(d.variant, d.generatedAt);
  }

  // Latest purchase per slug, so two orders for the same report collapse into
  // one send rather than rendering the same PDF twice in a row.
  const latestBuyFor = new Map<string, Date>();
  for (const p of purchases) {
    const prev = latestBuyFor.get(p.slug);
    if (!prev || p.purchasedAt > prev) latestBuyFor.set(p.slug, p.purchasedAt);
  }

  const outcomes: AutoDeliverOutcome[] = [];
  // Sequential: each delivery drives a Puppeteer render, and running several
  // headless Chromes at once on the same box is how this falls over.
  for (const [slug, purchasedAt] of latestBuyFor) {
    const sentAt = lastSentFor.get(slug);
    if (sentAt && sentAt >= purchasedAt) {
      outcomes.push({ slug, status: "skipped", reason: "Already sent since it was bought." });
      continue;
    }

    const spec = specForSlug(slug);
    if (!spec) {
      outcomes.push({ slug, status: "skipped", reason: `Unrecognised product "${slug}" — send this one by hand.` });
      continue;
    }

    try {
      // resend is implicit: reaching here means either it was never sent, or
      // it was bought again afterwards. deliverReportToQuantemo overwrites at
      // a path derived from the order, so a repeat send replaces the
      // customer's existing copy instead of leaving two behind.
      const result = await deliverReportToQuantemo(assessmentId, spec);
      if (result.ok) {
        outcomes.push({ slug: deliverySlug(spec), status: "sent", storagePath: result.storagePath, created: result.created });
      } else {
        outcomes.push({ slug, status: "failed", reason: result.reason });
      }
    } catch (err) {
      // One report failing to render must not strand the others this customer
      // paid for. Logged rather than swallowed — a render that throws is a
      // real fault, it just isn't a reason to abandon the rest of the round.
      console.error(`Auto-delivery of "${slug}" for assessment ${assessmentId} failed:`, err);
      outcomes.push({ slug, status: "failed", reason: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  return { attempted: true, warnings, outcomes };
}
