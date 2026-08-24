import { NextResponse } from "next/server";
import { isStudioKind, loadOrGenerateArtifact } from "@/lib/studioArtifacts";
import { renderStudioArtifactHtml, renderStudioError } from "@/lib/renderStudioArtifact";

export const runtime = "nodejs";

// The viewable form of a Studio artifact — a standalone HTML document, so the
// workspace can iframe it exactly the way it iframes a generated PDF. A route
// handler rather than a page.tsx for the same reason /report/[id] is one: the
// renderer returns a whole <html> document with its own styles, which would
// be invalid nested inside app/layout.tsx's own <html>.
export async function GET(req: Request, { params }: { params: Promise<{ kind: string; assessmentId: string }> }) {
  const { kind, assessmentId } = await params;
  if (!isStudioKind(kind)) return new NextResponse("Unknown studio artifact.", { status: 404 });

  let id: bigint;
  try {
    id = BigInt(assessmentId);
  } catch {
    return new NextResponse("Invalid client id.", { status: 400 });
  }

  const query = new URL(req.url).searchParams;
  const refresh = query.get("refresh") === "true";
  const result = await loadOrGenerateArtifact(kind, id, refresh, {
    topic: query.get("topic") ?? undefined,
    format: query.get("format") ?? undefined,
    length: query.get("length") ?? undefined,
  });

  // Failures render as a styled page inside the same frame, not an HTTP error
  // the iframe would show as a browser error page — staff should be able to
  // read WHY it didn't generate (see the earlier silent-Gemini-failure bug).
  const html = result.ok ? renderStudioArtifactHtml(kind, result.data) : renderStudioError(kind, result.error);
  return new NextResponse(html, {
    status: result.ok ? 200 : result.status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
