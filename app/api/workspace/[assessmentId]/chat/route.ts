import { NextResponse } from "next/server";
import { loadAssessmentForAi, loadClientHistoryForAi, buildClientDataSummary, buildClientHistorySummary } from "@/lib/clientData";
import { answerClientQuestion, type ChatTurn } from "@/lib/chat";

export const runtime = "nodejs";

// Stateless — the client sends its own conversation history with each
// message rather than this being persisted server-side. Simple to start
// with; if chat history needs to survive a page reload later, that's a
// small addition (a ChatMessage table), not a redesign.
export async function POST(req: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  try {
    const { assessmentId } = await params;
    let id: bigint;
    try {
      id = BigInt(assessmentId);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const question = typeof body.question === "string" ? body.question.trim() : "";
    // Named `turns` rather than `history`: further down, `history` is this
    // client's PREVIOUS ASSESSMENTS, which is a different thing entirely. The
    // wire field stays `history` — that's what the workspace page sends.
    const turns: ChatTurn[] = Array.isArray(body.history) ? body.history : [];
    if (!question) {
      return NextResponse.json({ error: "`question` is required." }, { status: 400 });
    }

    const assessment = await loadAssessmentForAi(id);
    if (!assessment) {
      return NextResponse.json({ error: `No assessment with id ${assessmentId}.` }, { status: 404 });
    }

    // Checked against the CURRENT round alone, not the combined block below —
    // buildClientHistorySummary always returns a non-empty string (it prints
    // a "--- CURRENT REPORT ---" header even when that round has nothing
    // yet), so checking the combined text would let an unprocessed round
    // through as long as some OTHER round for the same client had data.
    if (!buildClientDataSummary(assessment)) {
      return NextResponse.json({ error: "This assessment doesn't have enough processed content yet to answer questions about." }, { status: 422 });
    }

    const priorRounds = await loadClientHistoryForAi(assessment.clientId, assessment.id);
    const sourceText = buildClientHistorySummary(assessment, priorRounds);

    const answer = await answerClientQuestion(assessment.customerId, sourceText, question, turns);
    return NextResponse.json({ ok: true, answer });
  } catch (err) {
    console.error("Workspace chat endpoint failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
