import { NextResponse } from "next/server";
import { autoDeliverPurchasedReports } from "@/lib/autoDeliver";

// Puppeteer renders the PDF, so this needs a real Node process.
export const runtime = "nodejs";

/**
 * Fires once an upload batch has finished extracting, and sends whatever
 * this round's customer already paid for (see lib/autoDeliver.ts for the two
 * rules that bound it: purchases only, and never over a gap).
 *
 * Called after the WHOLE batch rather than from inside /api/extract-facts,
 * which runs per file. A three-file round (Aquera + Emotional Notes +
 * iEmoWave) would otherwise be gap-checked after file one, and any round
 * whose gaps happen to clear early would go out to the customer while the
 * remaining sources were still uploading — delivered, and immediately stale.
 * "Extraction is done" means the batch is done.
 *
 * No auth check beyond middleware, matching /api/deliver-report: every
 * /api/* route is already behind an admin session. This is reached by
 * finishing an upload, which is itself an admin-only action.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const idParam = typeof body.assessmentId === "string" ? body.assessmentId : "";
    if (!idParam) return NextResponse.json({ error: "`assessmentId` is required." }, { status: 400 });

    let assessmentId: bigint;
    try {
      assessmentId = BigInt(idParam);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    const result = await autoDeliverPurchasedReports(assessmentId);
    // Always 200: "nothing to send", "held back over a gap" and "sent two
    // reports" are all successful outcomes of asking. The caller is an
    // automatic post-upload step, and a non-2xx here would surface as a
    // failed upload for a round that extracted perfectly well.
    return NextResponse.json(result);
  } catch (err) {
    console.error("Auto-delivery failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
