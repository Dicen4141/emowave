import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Copies every report_facts row from one round into another.
 *
 * Why this exists: a repeat purchase arrives from Quantemo as a new, empty
 * round (see the webhook). The person hasn't retaken anything — it's the same
 * Mind Report and Emotional Notes behind it — so staff were re-uploading the
 * identical PDFs just to give the new round something to render from. This is
 * that, without the re-upload and without a second trip through extraction.
 *
 * CROSS-CLIENT COPYING IS ALLOWED, AND IT IS DANGEROUS. This route used to
 * refuse any copy between two different clients, on the grounds that these
 * facts ARE a named person's psychological assessment and attributing one
 * person's profile to another is the worst thing this app can do. That
 * refusal was lifted deliberately, because staff need to seed demo and test
 * rounds from real data. The danger did not go away with it:
 *
 *   - A cross-client copy is INVISIBLE afterwards. report_facts records no
 *     provenance, so a borrowed round is indistinguishable from an extracted
 *     one — to staff, to the chat, and to every renderer.
 *   - lib/autoDeliver.ts will render and send a complete-looking round to
 *     whoever paid for it, without a click. Its gap check cannot tell
 *     borrowed data from real data, because nothing can.
 *
 * So the two guards that remain are the callers': `crossClient: true` has to
 * be passed explicitly for a copy between different clients, and `replace:
 * true` for a copy onto a round that already has facts. Neither can happen by
 * a caller forgetting a field. A matching customerId is still NOT treated as
 * a matching person — Quantemo has duplicate names on purpose (see
 * lib/quantemo.ts), so a same-name copy between two different clientIds is
 * still a cross-client copy and still needs the flag.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null);

    let targetId: bigint;
    let sourceId: bigint;
    try {
      targetId = BigInt(id);
      sourceId = BigInt(String(body?.from ?? ""));
    } catch {
      return NextResponse.json({ error: "Both the round id and `from` must be numbers." }, { status: 400 });
    }
    if (targetId === sourceId) {
      return NextResponse.json({ error: "That's the same round." }, { status: 400 });
    }

    const [target, source] = await Promise.all([
      prisma.assessment.findUnique({
        where: { id: targetId },
        select: { id: true, clientId: true, customerId: true, _count: { select: { facts: true } } },
      }),
      prisma.assessment.findUnique({
        where: { id: sourceId },
        select: { id: true, clientId: true, customerId: true },
      }),
    ]);
    if (!target) return NextResponse.json({ error: `No round with id ${targetId}.` }, { status: 404 });
    if (!source) return NextResponse.json({ error: `No round with id ${sourceId}.` }, { status: 404 });

    // An unlinked round (clientId null) can't be proven to be the same person
    // either way, so it counts as cross-client rather than being guessed at.
    const crossClient = !target.clientId || !source.clientId || target.clientId !== source.clientId;
    if (crossClient && body?.crossClient !== true) {
      return NextResponse.json(
        {
          error:
            `"${source.customerId}" and "${target.customerId}" are different clients. ` +
            "Copying between them attributes one person's assessment to another — confirm it explicitly to go ahead.",
          crossClient: true,
          sourceName: source.customerId,
          targetName: target.customerId,
        },
        { status: 409 },
      );
    }

    // Never MERGE into a round that already has facts: the result would be
    // two overlapping sets with no way to tell which upload a row came from,
    // and every report reading them would silently double up. Replacing is
    // fine, but it destroys whatever was there, so the caller has to say so.
    if (target._count.facts > 0 && body?.replace !== true) {
      return NextResponse.json(
        {
          error: `This round already has ${target._count.facts} facts. Replacing will delete them first.`,
          needsReplace: true,
          existingFacts: target._count.facts,
        },
        { status: 409 },
      );
    }

    const facts = await prisma.reportFact.findMany({
      where: { assessmentId: sourceId },
      select: { sourceReport: true, section: true, label: true, value: true },
      orderBy: { id: "asc" },
    });
    if (facts.length === 0) {
      return NextResponse.json({ error: "That round has no facts to copy." }, { status: 409 });
    }

    // report_facts alone is NOT a complete round. Extraction also writes the
    // per-section "*Content" tables that Gemini generates alongside the raw
    // fields (see lib/saveEnhancedContent.ts), and checkReportGaps reads two
    // of them — journeyOverviewContent and topAttributeContent. A facts-only
    // copy therefore produces a round that LOOKS filled in, renders with
    // empty sections, and can never pass the readiness check that
    // lib/autoDeliver.ts gates on. So the derived content comes too.
    //
    // mindMapContent and studioArtifacts deliberately don't: those are
    // generated deliverables rather than report content, they regenerate on
    // demand, and nothing in the gap check reads them.
    //
    // fwmOverviewContent is excluded for a STRONGER reason. It is AI-composed
    // prose that opens by addressing the client BY NAME ("<name>, your
    // financial profile is…"), so copying it printed the source person's real
    // name in the target person's delivered PDF. It regenerates from the
    // target's own customerId when absent (see fwmOverviewParagraphs), so
    // leaving it behind is both safer and correct.
    const [stress, emotional, sensory, present, topAttrs, wellness, fwmOverview, journey] = await Promise.all([
      prisma.stressContent.findUnique({ where: { assessmentId: sourceId }, select: { description: true } }),
      prisma.emotionalStateContent.findUnique({
        where: { assessmentId: sourceId },
        select: {
          note1ReactionDesc: true,
          note2ReactionDesc: true,
          publicSelfFull: true,
          privateSelfFull: true,
          frequentEmotionDesc: true,
          coreEmotionDesc: true,
          empoweringDesc: true,
          disempoweringDesc: true,
        },
      }),
      prisma.sensoryAttributesContent.findUnique({ where: { assessmentId: sourceId }, select: { baseDesc: true, nextDesc: true } }),
      prisma.presentCharacterContent.findUnique({
        where: { assessmentId: sourceId },
        select: { presentTrait: true, presentSummary: true, realTrait: true, realSummary: true },
      }),
      prisma.topAttributeContent.findMany({
        where: { assessmentId: sourceId },
        select: { kind: true, rank: true, label: true, description: true },
        orderBy: { id: "asc" },
      }),
      prisma.wellnessChallengeContent.findMany({
        where: { assessmentId: sourceId },
        select: { rank: true, label: true, description: true },
        orderBy: { id: "asc" },
      }),
      prisma.fwmOverviewContent.findUnique({ where: { assessmentId: sourceId }, select: { paragraphs: true, model: true } }),
      prisma.journeyOverviewContent.findUnique({ where: { assessmentId: sourceId }, select: { noteBalanceValues: true } }),
    ]);

    // `embedding` is deliberately not carried across. It's declared on the
    // model as an Unsupported() pgvector column but nothing in this app
    // writes or reads it, so copying it would mean dropping to raw SQL to
    // move data no code path consumes.
    //
    // One transaction because every replace deletes first: a failure partway
    // would otherwise leave the round emptier than it started, having
    // destroyed real extracted content to make room for a copy that never
    // landed. The deletes are unconditional — a target with nothing to delete
    // is the ordinary empty-round case, and clearing a section the source
    // doesn't have is the point of "replace".
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.reportFact.deleteMany({ where: { assessmentId: targetId } }),
      prisma.stressContent.deleteMany({ where: { assessmentId: targetId } }),
      prisma.emotionalStateContent.deleteMany({ where: { assessmentId: targetId } }),
      prisma.sensoryAttributesContent.deleteMany({ where: { assessmentId: targetId } }),
      prisma.presentCharacterContent.deleteMany({ where: { assessmentId: targetId } }),
      prisma.topAttributeContent.deleteMany({ where: { assessmentId: targetId } }),
      prisma.wellnessChallengeContent.deleteMany({ where: { assessmentId: targetId } }),
      prisma.fwmOverviewContent.deleteMany({ where: { assessmentId: targetId } }),
      prisma.journeyOverviewContent.deleteMany({ where: { assessmentId: targetId } }),
      prisma.reportFact.createMany({
        // A null `value` is a real, meaningful row here — a field the extractor
        // looked for and did not find (see extractTemplateFacts). Prisma needs
        // that spelled as Prisma.JsonNull to store a JSON null rather than as
        // undefined, which would drop the column and lose the distinction
        // between "not found" and "never asked".
        data: facts.map((f) => ({ ...f, assessmentId: targetId, value: f.value === null ? Prisma.JsonNull : f.value })),
      }),
    ];
    if (stress) ops.push(prisma.stressContent.create({ data: { assessmentId: targetId, ...stress } }));
    if (emotional) ops.push(prisma.emotionalStateContent.create({ data: { assessmentId: targetId, ...emotional } }));
    if (sensory) ops.push(prisma.sensoryAttributesContent.create({ data: { assessmentId: targetId, ...sensory } }));
    if (present) ops.push(prisma.presentCharacterContent.create({ data: { assessmentId: targetId, ...present } }));
    if (topAttrs.length > 0)
      ops.push(prisma.topAttributeContent.createMany({ data: topAttrs.map((r) => ({ ...r, assessmentId: targetId })) }));
    if (wellness.length > 0)
      ops.push(prisma.wellnessChallengeContent.createMany({ data: wellness.map((r) => ({ ...r, assessmentId: targetId })) }));
    if (fwmOverview)
      ops.push(
        prisma.fwmOverviewContent.create({
          // `paragraphs` is a non-nullable Json column, so a source row that
          // somehow holds SQL NULL becomes an empty list rather than blowing
          // up the whole transaction.
          data: { assessmentId: targetId, model: fwmOverview.model, paragraphs: fwmOverview.paragraphs ?? [] },
        }),
      );
    if (journey)
      ops.push(
        prisma.journeyOverviewContent.create({
          data: {
            assessmentId: targetId,
            noteBalanceValues: journey.noteBalanceValues === null ? Prisma.JsonNull : journey.noteBalanceValues,
          },
        }),
      );

    await prisma.$transaction(ops);

    return NextResponse.json({
      ok: true,
      copied: facts.length,
      replaced: target._count.facts,
      crossClient,
      sourceName: source.customerId,
      // What came across besides the raw fields, so the caller can say why a
      // copied round is now actually renderable.
      content: {
        stress: !!stress,
        emotional: !!emotional,
        sensory: !!sensory,
        present: !!present,
        topAttributes: topAttrs.length,
        wellness: wellness.length,
        fwmOverview: !!fwmOverview,
        journeyOverview: !!journey,
      },
      from: sourceId.toString(),
      to: targetId.toString(),
    });
  } catch (err) {
    console.error("Copy facts between rounds failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
