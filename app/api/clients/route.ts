import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Client-centric view of everything on file — the counterpart to
 * /api/assessments, which lists rounds flat with no idea who owns them.
 *
 * A client's display name comes from their most recent round's customerId
 * rather than being stored on the Client: the name is whatever that round's
 * PDF said, and the authoritative name lives in Quantemo's users table.
 */
export async function GET() {
  const clients = await prisma.client.findMany({
    orderBy: { id: "desc" },
    include: {
      assessments: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          customerId: true,
          customerEmail: true,
          ageAtAssessment: true,
          createdAt: true,
          _count: { select: { facts: true, generatedReports: true } },
        },
      },
    },
  });

  // Which report templates each round actually holds, in one grouped query
  // rather than a per-round lookup — this list grows with every client.
  const bySource = await prisma.reportFact.groupBy({
    by: ["assessmentId", "sourceReport"],
    _count: { _all: true },
  });
  const sources = new Map<string, string[]>();
  for (const row of bySource) {
    const key = row.assessmentId.toString();
    sources.set(key, [...(sources.get(key) ?? []), row.sourceReport]);
  }

  return NextResponse.json({
    clients: clients.map((c) => {
      const rounds = c.assessments;
      const latest = rounds[0];
      return {
        id: c.id.toString(),
        quantemoUuid: c.quantemoUuid,
        linked: Boolean(c.quantemoUuid),
        // Falls back only when a client somehow has no rounds at all — a
        // client is always created alongside one, so this is defensive.
        name: latest?.customerId ?? "(no rounds)",
        email: rounds.find((r) => r.customerEmail)?.customerEmail ?? null,
        rounds: rounds.map((r) => ({
          id: r.id.toString(),
          name: r.customerId,
          factCount: r._count.facts,
          reportCount: r._count.generatedReports,
          age: r.ageAtAssessment,
          createdAt: r.createdAt,
          sources: (sources.get(r.id.toString()) ?? []).sort(),
        })),
      };
    }),
  });
}
