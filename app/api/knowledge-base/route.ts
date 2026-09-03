import { NextResponse } from "next/server";
import { buildDeliveryKnowledgeBase } from "@/lib/knowledgeBase";

export const runtime = "nodejs";

/**
 * Read-only preview of the three `payload` keys a delivery would carry for a
 * round — knowledge_base, chat_prompt, knowledge_base_generated_at.
 *
 * DELIVERS NOTHING. No PDF is rendered, no storage upload happens, no row is
 * written to Quantemo, and no customer is touched. It exists so the Quantemo
 * report chat can be built and validated against real output before a real
 * buyer ever sees one — the same reason it goes through
 * buildDeliveryKnowledgeBase() rather than assembling its own text: a preview
 * from a second code path would validate something other than what ships.
 *
 * GET /api/knowledge-base?assessmentId=144
 *
 * Admin-session only, via middleware's blanket /api/* rule — deliberately NOT
 * exempted the way the Quantemo webhook is. This returns a named person's
 * full assessment history in plain text for any id passed to it, and ids are
 * sequential integers, so an unauthenticated version would be an enumerable
 * dump of every client on file. Staff pull samples; it is not a Quantemo
 * integration point.
 *
 * `knowledge_base_generated_at` is stamped now, at preview time — it reflects
 * when THIS text was built, not when anything was delivered.
 */
export async function GET(req: Request) {
  try {
    const idParam = new URL(req.url).searchParams.get("assessmentId") ?? "";
    if (!idParam) return NextResponse.json({ error: "Missing ?assessmentId=" }, { status: 400 });

    let assessmentId: bigint;
    try {
      assessmentId = BigInt(idParam);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    // ?slug=fwm|overview|career|relationship|full previews exactly what that
    // variant's row would carry. Omitted means everything, so staff can see
    // the full picture in one request.
    const slug = new URL(req.url).searchParams.get("slug") ?? undefined;
    const kb = await buildDeliveryKnowledgeBase(assessmentId, slug);
    // 200 with all-null rather than 404: "this round isn't ready to answer
    // questions from" is exactly the state Quantemo has to handle, so the
    // preview reproduces it instead of turning it into an error they'd never
    // see in the payload.
    return NextResponse.json(kb);
  } catch (err) {
    console.error("Knowledge base preview failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
