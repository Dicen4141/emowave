import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverReportToQuantemo, deliverySlug, type DeliverSpec, type DeliverVariant, type DeliverTheme } from "@/lib/quantemoDelivery";

// Puppeteer renders the PDF, so this needs a real Node process.
export const runtime = "nodejs";

const VARIANTS: DeliverVariant[] = ["overview", "full", "fwm"];
const THEMES: DeliverTheme[] = ["career", "relationship"];

// Sends a finished report to the person who bought it. Every /api route is
// already behind an admin session (see middleware.ts), so there's no extra
// auth check here — but this is the one route that writes to a customer's
// account rather than to EmoWave's own data, so it stays an explicit staff
// action rather than firing automatically when a round is processed.
// Which reports for this round have already gone to the customer, so the UI
// can say so before staff click rather than only after a refused POST.
export async function GET(req: Request) {
  const idParam = new URL(req.url).searchParams.get("assessmentId") ?? "";
  if (!idParam) return NextResponse.json({ error: "Missing ?assessmentId=" }, { status: 400 });
  let assessmentId: bigint;
  try {
    assessmentId = BigInt(idParam);
  } catch {
    return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
  }
  const [rows, purchases] = await Promise.all([
    prisma.generatedReport.findMany({ where: { assessmentId, delivered: true }, select: { variant: true, generatedAt: true } }),
    prisma.reportPurchase.findMany({ where: { assessmentId }, select: { slug: true, quantemoOrderId: true, purchasedAt: true } }),
  ]);
  return NextResponse.json({
    delivered: rows.map((r) => ({ variant: r.variant, at: r.generatedAt.toISOString() })),
    purchased: purchases.map((p) => ({ slug: p.slug, orderId: p.quantemoOrderId, at: p.purchasedAt.toISOString() })),
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const idParam = typeof body.assessmentId === "string" ? body.assessmentId : "";
    if (!idParam) return NextResponse.json({ error: "`assessmentId` is required." }, { status: 400 });

    // Mirrors the report the caller was previewing. A theme only means
    // anything for the EmoWave renderer, so it's ignored for FWM rather than
    // silently producing a themed FWM report that doesn't exist.
    const variant: DeliverVariant = VARIANTS.includes(body.variant) ? body.variant : "overview";
    const theme: DeliverTheme | undefined =
      variant !== "fwm" && THEMES.includes(body.theme) ? body.theme : undefined;
    const spec: DeliverSpec = { variant, theme };

    let assessmentId: bigint;
    try {
      assessmentId = BigInt(idParam);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    // Delivered once is the normal case: staff shouldn't be able to re-send
    // by double-clicking, or by reopening a preview later and forgetting it
    // already went out. A genuine correction is still possible, but it has to
    // be asked for explicitly (resend: true) rather than happening by
    // accident — hence 409 rather than silently re-delivering.
    const slug = deliverySlug(spec);
    if (body.resend !== true) {
      const [already, latestPurchase] = await Promise.all([
        prisma.generatedReport.findFirst({
          where: { assessmentId, variant: slug, delivered: true },
          select: { generatedAt: true },
        }),
        prisma.reportPurchase.findFirst({
          where: { assessmentId, slug },
          orderBy: { purchasedAt: "desc" },
          select: { purchasedAt: true },
        }),
      ]);
      // A purchase made AFTER the last delivery is a customer paying for that
      // report a second time — they're owed a fresh copy, so this isn't the
      // accidental double-send the guard exists to stop. Blocking it would
      // make staff override a warning to fulfil an order they were paid for.
      const boughtAgainSinceDelivery =
        !!already && !!latestPurchase && latestPurchase.purchasedAt > already.generatedAt;
      if (already && !boughtAgainSinceDelivery) {
        return NextResponse.json(
          {
            error: `This report was already sent on ${already.generatedAt.toISOString().slice(0, 16).replace("T", " ")}.`,
            alreadyDelivered: true,
          },
          { status: 409 },
        );
      }
    }

    const result = await deliverReportToQuantemo(assessmentId, spec);
    // A refusal here is a state the caller needs to read (no linked order,
    // unpaid, nothing to render yet), not a server fault — 422 so the UI can
    // show the reason rather than a generic failure.
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 422 });

    return NextResponse.json({
      ok: true,
      storagePath: result.storagePath,
      buyerId: result.buyerId,
      created: result.created,
    });
  } catch (err) {
    console.error("Report delivery to Quantemo failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
