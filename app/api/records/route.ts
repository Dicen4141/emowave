import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Returns all saved documents (newest first) with their table rows.
export async function GET() {
  const documents = await prisma.document.findMany({
    orderBy: { createdAt: "desc" },
    include: { rows: true },
  });
  return NextResponse.json({ documents });
}
