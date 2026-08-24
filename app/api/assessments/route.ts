import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAdminUser } from "@/lib/adminAuth";
import { lookupQuantemoUser } from "@/lib/quantemo";

export const runtime = "nodejs";

// Lists saved assessments so the UI can offer a "pick one to generate a PDF
// for" list, without ever generating anything automatically.
export async function GET() {
  const assessments = await prisma.assessment.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { facts: true } } },
  });

  return NextResponse.json({
    assessments: assessments.map((a) => ({
      id: a.id.toString(),
      // Lets the UI group a client's rounds together and number them (v1,
      // v2, ...) instead of every round appearing as an unrelated flat row —
      // null for the rare unlinked/legacy assessment, which the UI treats as
      // its own single-round group.
      clientId: a.clientId?.toString() ?? null,
      customerId: a.customerId,
      status: a.status,
      factCount: a._count.facts,
      createdAt: a.createdAt,
    })),
  });
}

/**
 * Creates an empty client by name, so one can be set up before any PDF
 * arrives. Uploading a report still creates a client on its own (see
 * app/api/extract-facts/route.ts) — this exists so that isn't the *only* way,
 * which is what made a failed name-read silently leave a client named after
 * the file behind.
 *
 * Superadmin-only, matching the identical rule extract-facts already applies
 * to adding a brand-new client — otherwise this route would be a way around it.
 */
export async function POST(req: Request) {
  try {
    const adminUser = await getAdminUser();
    if (adminUser?.role !== "superadmin") {
      return NextResponse.json({ error: "Only a superadmin can add a new client." }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    if (!name) return NextResponse.json({ error: "A client needs a name." }, { status: 400 });

    // Matched case-insensitively on the same field extract-facts matches on,
    // so creating "jane doe" here and later uploading a PDF that reads
    // "Jane Doe" lands in this record rather than forking a second one.
    const existing = await prisma.assessment.findFirst({
      where: { customerId: { equals: name, mode: "insensitive" } },
      orderBy: { id: "desc" },
    });
    if (existing) {
      // 409 with the id, so the UI can just select the client they meant
      // instead of making them go find it in the list.
      return NextResponse.json(
        { error: `${existing.customerId} already exists.`, assessmentId: existing.id.toString() },
        { status: 409 },
      );
    }

    // Resolve the Quantemo link now, while someone is here to type the email.
    // Doing it at creation is what stops the backfill pile growing: an
    // unlinked client has to be matched by hand later.
    const quantemo = email ? await lookupQuantemoUser(email) : null;
    if (email && !quantemo) {
      return NextResponse.json(
        { error: `No Quantemo customer found with the email ${email}. Check the address, or leave it blank to link later.` },
        { status: 422 },
      );
    }

    // An existing Client row for this Quantemo customer means they're a
    // returning buyer — the new assessment becomes another ROUND against the
    // same person rather than a second, disconnected client record.
    //
    // findFirst, not findUnique: quantemoUuid stopped being unique when one
    // account became able to hold a whole family. This path is staff creating
    // a round by hand, which is always for the account holder themselves, so
    // it matches only the client with no family profile attached — otherwise
    // it could pick up a child who happens to sit under the same account.
    const client = quantemo
      ? ((await prisma.client.findFirst({ where: { quantemoUuid: quantemo.uuid, subjectProfileId: null } })) ??
        (await prisma.client.create({ data: { quantemoUuid: quantemo.uuid } })))
      : await prisma.client.create({ data: {} });

    const created = await prisma.assessment.create({
      data: {
        customerId: name,
        status: "ready",
        clientId: client.id,
        customerEmail: email || null,
        // Snapshotted per round: Quantemo's users.age moves with every
        // birthday, but this round's report must keep saying what it said.
        ageAtAssessment: quantemo?.age ?? null,
      },
    });
    return NextResponse.json({ ok: true, assessmentId: created.id.toString() }, { status: 201 });
  } catch (err) {
    console.error("Client create failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
