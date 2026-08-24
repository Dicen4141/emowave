import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { extractTemplateFacts } from "@/lib/extractTemplateFacts";
import { EXTRACTIONS_DIR } from "@/lib/saveText";
import { prisma } from "@/lib/db";
import { saveEnhancedContent, refreshFallbackTopAttributes } from "@/lib/saveEnhancedContent";
import { getAdminUser } from "@/lib/adminAuth";

// Groups a label like "Public Self - full" under section "Public Self".
// Labels with no " - " (e.g. "9 Points Type summary") are their own section.
function sectionFromLabel(label: string) {
  const idx = label.indexOf(" - ");
  return idx === -1 ? label : label.slice(0, idx);
}

// Node runtime (Buffer + fs are not supported on the Edge runtime).
export const runtime = "nodejs";

function safeBaseName(fileName: string) {
  const base = path.basename(fileName).replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[^a-zA-Z0-9-_ ]/g, "_").trim();
  return cleaned.slice(0, 60) || "document";
}

// Same person, different report types spelling their name differently, is a
// real recurring case (confirmed multiple times: "Nassirdeen Yahaya" on
// their Emotional Notes report vs "Nassirdeen Yahaya Kwande" on their Aquera
// Mind Report) — exact-string matching alone forks them into two clients
// every time. A WORD-BY-WORD prefix check (not a raw substring check) treats
// "Nassirdeen Yahaya" as the same person as "Nassirdeen Yahaya Kwande"
// (every word of the shorter name matches the longer one's words in order
// from the start) while still telling apart two genuinely different people
// who happen to share a first name — "Nas" is not a word-match for
// "Nassirdeen", and "John Smith" is not a word-match for "John Smithson".
// Deliberately scoped to ONLY the "is this upload for the client I already
// have open" check (see below) — a general fuzzy search across every client
// in the system would risk merging two different people who share a common
// first/last name, which this project has been careful to avoid.
function namesLikelySamePerson(a: string, b: string): boolean {
  const wordsA = a.trim().toLowerCase().split(/\s+/);
  const wordsB = b.trim().toLowerCase().split(/\s+/);
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  return shorter.length > 0 && shorter.every((w, i) => w === longer[i]);
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("pdf");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No PDF file uploaded." }, { status: 400 });
    }
    if (file.type !== "application/pdf") {
      return NextResponse.json({ error: "File must be a PDF." }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    let result: Awaited<ReturnType<typeof extractTemplateFacts>>;
    try {
      result = await extractTemplateFacts(bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 422 });
    }

    const when = new Date();
    const stamp = when.toISOString().replace(/[:.]/g, "-");
    const textPath = path.join(EXTRACTIONS_DIR, `${stamp}-${safeBaseName(file.name)}-facts.txt`);

    const notFound = result.fields.filter((f) => f.text === null);
    const lines = [
      `Source PDF: ${file.name}`,
      `Template:   ${result.template}`,
      `Extracted:  ${when.toISOString()}`,
      `Fields found: ${result.fields.length - notFound.length}/${result.fields.length}`,
      "=".repeat(70),
      "",
    ];
    for (const f of result.fields) {
      lines.push(`[${f.label}]`, f.text ?? "!! NOT FOUND !!", "");
    }

    await mkdir(EXTRACTIONS_DIR, { recursive: true });
    await writeFile(textPath, lines.join("\r\n"), "utf8");

    // Still no real customer/order system — but we can now do better than
    // "one Assessment per upload": if the PDF's own page 1 names the client
    // (works for all 3 known templates), reuse their existing Assessment so
    // Aquera + Emotional Notes + iEmoWave Full reports for the same person
    // land in one place instead of three disconnected records. Falls back
    // to the filename (and always creates fresh) only when no name could
    // be read off the page.
    const customerId = result.clientName ?? file.name;

    // Workspace sends the round the admin actually has open (`targetAssessmentId`)
    // so a correction always lands on THAT round — without this, "join the
    // existing round" fell back to "whichever round is newest for this
    // name," which silently patched the wrong round whenever staff were
    // looking at an older one (e.g. fixing v1 after v2 already exists would
    // have corrected v2 instead). The standalone Extract page has no
    // "currently open round" concept, so it never sends this and keeps the
    // old newest-by-name behavior.
    const targetAssessmentIdRaw = formData.get("targetAssessmentId");
    let existing = null as Awaited<ReturnType<typeof prisma.assessment.findFirst>>;
    // Set when the open client turned out to be the wrong one for this PDF
    // (see the name check below) — surfaced in the response so the UI can
    // tell staff "this went to X instead of the client you had open" rather
    // than silently filing it away somewhere they didn't expect.
    let redirectedFrom: string | null = null;
    if (typeof targetAssessmentIdRaw === "string" && targetAssessmentIdRaw) {
      let targeted: Awaited<ReturnType<typeof prisma.assessment.findUnique>>;
      try {
        targeted = await prisma.assessment.findUnique({ where: { id: BigInt(targetAssessmentIdRaw) } });
      } catch {
        return NextResponse.json({ error: "targetAssessmentId must be a number." }, { status: 400 });
      }
      // Staff can have Client A open in Workspace and, by mistake, pick a
      // file for Client B — targetAssessmentId alone can't catch that (it's
      // just "whichever round was open," not a promise the file matches).
      // When the PDF's own page names its owner and it DOESN'T match the
      // open client (word-prefix aware, see namesLikelySamePerson — this is
      // what lets "Nassirdeen Yahaya" on an Emotional Notes report still
      // count as the open "Nassirdeen Yahaya Kwande" client instead of
      // forking a new one), that's real evidence this upload belongs
      // somewhere else — rather than merging it into the wrong person's
      // round (or just refusing and making staff redo the upload by hand),
      // fall back to the same name-based lookup the standalone Extract page
      // always uses, so it lands on the RIGHT existing client (or creates a
      // new one) automatically.
      const samePerson = targeted && result.clientName && namesLikelySamePerson(targeted.customerId, result.clientName);
      const mismatch = targeted && result.clientName && !samePerson;
      if (mismatch) {
        redirectedFrom = targeted!.customerId;
        existing = await prisma.assessment.findFirst({
          where: { customerId: { equals: customerId, mode: "insensitive" } },
          orderBy: { id: "desc" },
        });
      } else {
        existing = targeted;
        // The fuller spelling is the more useful one to display/search by
        // going forward — e.g. once a "Nassirdeen Yahaya Kwande" Aquera
        // report exists, a later "Nassirdeen Yahaya" Emotional Notes upload
        // shouldn't downgrade the client's name back to the shorter form.
        if (existing && result.clientName && result.clientName.length > existing.customerId.length) {
          existing = await prisma.assessment.update({ where: { id: existing.id }, data: { customerId: result.clientName } });
        }
      }
    } else if (result.clientName) {
      existing = await prisma.assessment.findFirst({
        where: { customerId: { equals: customerId, mode: "insensitive" } },
        orderBy: { id: "desc" },
      });
    }

    // Adding a brand-new client is restricted to superadmin — a regular
    // admin can only extract/generate for clients that already exist.
    if (!existing) {
      const adminUser = await getAdminUser();
      if (adminUser?.role !== "superadmin") {
        return NextResponse.json(
          {
            error:
              "Only a superadmin can add a new client. Ask a superadmin to add this client first, then you'll be able to extract reports for them.",
          },
          { status: 403 },
        );
      }
    }

    // An upload for someone already on file joins THEIR CURRENT ROUND by
    // default — the three report types are three parts of one purchase, so
    // they belong to one assessment. A repeat purchase is a deliberate "new
    // round" action, not something inferred from an upload: staff re-upload a
    // corrected PDF often enough (fixing a bad extraction) that treating
    // every re-upload as a new purchase would fork a client's history on a
    // routine correction. Staff opt into a genuine new round explicitly via
    // the "This is a new report" checkbox (`newRound` on the form) instead —
    // same round stays untouched, a new dated one is created alongside it,
    // linked to the same Client so chat/report history can compare them.
    const wantsNewRound = formData.get("newRound") === "true";
    const assessment =
      existing && !wantsNewRound
        ? existing
        : await prisma.assessment.create({
            data: {
              customerId,
              status: "ready",
              client: existing?.clientId ? { connect: { id: existing.clientId } } : { create: {} },
            },
          });

    // Re-extracting the SAME report type for a client already in the
    // assessment (e.g. re-uploading their Aquera report) should REPLACE
    // that report's facts, not pile a second copy on top — otherwise every
    // section shows up twice in the generated report.
    const foundFields = result.fields.filter((f) => f.text !== null);

    // Only clear the labels THIS extraction actually found, not every label
    // ever saved for this report type. A label that fails this time (e.g.
    // the Note Balance chart during a Gemini outage) keeps whatever a past
    // successful extraction saved, instead of being wiped out by this
    // attempt's failure — a blanket delete-everything-then-insert-successes
    // was silently erasing previously-good data on every re-upload made
    // while a field was down.
    const joinedExistingRound = existing !== null && assessment.id === existing.id;

    // A purchase that hasn't been fulfilled yet belongs to whichever round
    // will actually fulfil it. Someone who re-buys a report and then sits the
    // assessment again expects the NEW data, so when staff open a new round
    // any still-owed purchases move across with it — otherwise the purchase
    // is stranded on the old round (which shows "Purchased" but holds stale
    // facts) while the new round shows nothing owed at all.
    // Already-delivered purchases stay put: they record what that round's
    // report was sent for, and are the history the send-once guard reads.
    if (existing && !joinedExistingRound) {
      const [carried, sent] = await Promise.all([
        prisma.reportPurchase.findMany({
          where: { assessmentId: existing.id },
          select: { id: true, slug: true, purchasedAt: true },
        }),
        prisma.generatedReport.findMany({
          where: { assessmentId: existing.id, delivered: true },
          select: { variant: true, generatedAt: true },
        }),
      ]);
      const lastSentFor = new Map<string, Date>();
      for (const d of sent) {
        const prev = lastSentFor.get(d.variant);
        if (!prev || d.generatedAt > prev) lastSentFor.set(d.variant, d.generatedAt);
      }
      const owed = carried.filter((c) => {
        const at = lastSentFor.get(c.slug);
        return !at || c.purchasedAt > at;
      });
      if (owed.length > 0) {
        await prisma.reportPurchase.updateMany({
          where: { id: { in: owed.map((o) => o.id) } },
          data: { assessmentId: assessment.id },
        });
      }
    }
    if (joinedExistingRound && foundFields.length > 0) {
      await prisma.reportFact.deleteMany({
        where: {
          assessmentId: assessment.id,
          sourceReport: result.template,
          label: { in: foundFields.map((f) => f.label) },
        },
      });
    }

    if (foundFields.length > 0) {
      await prisma.reportFact.createMany({
        data: foundFields.map((f) => ({
          assessmentId: assessment.id,
          sourceReport: result.template,
          section: sectionFromLabel(f.label),
          label: f.label,
          value: f.text as string,
        })),
      });
    }

    // Everything Gemini generated or rewrote for this upload — saved
    // separately from the raw fields above, into the section-specific
    // "*Content" tables rather than ReportFact.
    await saveEnhancedContent(assessment.id, result.enhanced, foundFields);
    await refreshFallbackTopAttributes(assessment.id);

    return NextResponse.json({
      ok: true,
      template: result.template,
      fields: result.fields,
      textFile: textPath,
      assessmentId: assessment.id.toString(),
      clientName: result.clientName,
      mergedIntoExisting: joinedExistingRound,
      newRoundCreated: existing !== null && !joinedExistingRound,
      // Set when this upload didn't match whichever client was open in
      // Workspace and got automatically routed to the right one instead —
      // the UI shows this so it's obvious the data didn't just land wherever
      // was on screen.
      redirectedFrom,
      factsSaved: foundFields.length,
      // Surfaced directly in the Extract UI so a silently-missing field
      // (e.g. the Note Balance chart failing to read) is visible right at
      // upload time instead of only discoverable later by generating the
      // report and noticing something's missing, or digging through server
      // logs / the saved .txt file.
      missingFields: notFound.map((f) => f.label),
    });
  } catch (err) {
    console.error("Template fact extraction failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
