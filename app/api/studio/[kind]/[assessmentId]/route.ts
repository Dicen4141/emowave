import { NextResponse } from "next/server";
import { isStudioKind, loadOrGenerateArtifact, STUDIO_KINDS } from "@/lib/studioArtifacts";

export const runtime = "nodejs";

// JSON form of a Studio artifact, for anything that wants the data rather
// than the rendered page (the HTML view lives at /studio/<kind>/<id>). Both
// go through the same loadOrGenerateArtifact(), so they always agree.
// ?refresh=true forces a fresh Gemini call instead of the cached row, and
// ?topic=... narrows what the artifact covers (which also forces a fresh
// call, since the cached row was generated for a different ask).
export async function GET(req: Request, { params }: { params: Promise<{ kind: string; assessmentId: string }> }) {
  try {
    const { kind, assessmentId } = await params;
    if (!isStudioKind(kind)) {
      return NextResponse.json({ error: `kind must be one of: ${STUDIO_KINDS.join(", ")}.` }, { status: 400 });
    }

    let id: bigint;
    try {
      id = BigInt(assessmentId);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    const query = new URL(req.url).searchParams;
    const refresh = query.get("refresh") === "true";
    const result = await loadOrGenerateArtifact(kind, id, refresh, {
      topic: query.get("topic") ?? undefined,
      format: query.get("format") ?? undefined,
      length: query.get("length") ?? undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json(result);
  } catch (err) {
    console.error("Studio artifact endpoint failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
