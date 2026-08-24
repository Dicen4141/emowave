import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { renderReportHtml, htmlToPdf } from "@/lib/renderReportPdf";
import { renderEwFullReportHtml, type ReportTheme, type ReportVariant } from "@/lib/renderEwFullReport";
import { renderFwmReportHtml, fwmPdfChrome } from "@/lib/renderFwmReport";

const THEMES: ReportTheme[] = ["career", "relationship"];
// "fwm" is the Financial Wealth Management report — a separate report TYPE
// with its own renderer and its own reference tables, not a view of the
// EmoWave Full report, so it's a variant rather than another theme. It ignores
// `theme` entirely (its section list is fixed by the vendor's template).
const VARIANTS: ReportVariant[] = ["full", "overview", "fwm"];

// FWM replaced the old "finance" theme (a section subset of the EmoWave Full
// report). The value is still accepted so links issued before the switch —
// and any stored generated_reports row carrying it — resolve to the report
// that now occupies that slot, rather than 400-ing.
const LEGACY_FINANCE_THEME = "finance";

// Node runtime (Puppeteer needs a real Node process, not the Edge runtime).
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const idParam = searchParams.get("assessmentId");
    if (!idParam) {
      return NextResponse.json({ error: "Missing ?assessmentId=" }, { status: 400 });
    }
    const themeParam = searchParams.get("theme");
    const isLegacyFinance = themeParam === LEGACY_FINANCE_THEME;
    if (themeParam && !isLegacyFinance && !THEMES.includes(themeParam as ReportTheme)) {
      return NextResponse.json(
        { error: `theme must be one of: ${THEMES.join(", ")}.` },
        { status: 400 },
      );
    }
    // A legacy ?theme=finance carries no theme through to the EmoWave renderer
    // — it selects the FWM report below instead.
    const theme = isLegacyFinance ? undefined : (themeParam as ReportTheme | undefined);

    const variantParam = searchParams.get("variant");
    if (variantParam && !VARIANTS.includes(variantParam as ReportVariant)) {
      return NextResponse.json({ error: `variant must be one of: ${VARIANTS.join(", ")}.` }, { status: 400 });
    }
    const variant: ReportVariant = isLegacyFinance ? "fwm" : ((variantParam as ReportVariant | null) ?? "full");

    // FWM's opening overview is AI-composed and cached per round, so every
    // download reissues the same words. ?refresh=1 is the way to replace a bad
    // first result — it regenerates and overwrites the cache.
    const refreshOverview = searchParams.get("refresh") === "1";

    let assessmentId: bigint;
    try {
      assessmentId = BigInt(idParam);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        facts: true,
        stressContent: true,
        emotionalStateContent: true,
        sensoryAttributesContent: true,
        presentCharacterContent: true,
        topAttributeContent: true,
        wellnessChallengeContent: true,
        journeyOverviewContent: true,
      },
    });

    if (!assessment) {
      return NextResponse.json({ error: `No assessment with id ${idParam}.` }, { status: 404 });
    }
    if (assessment.facts.length === 0) {
      return NextResponse.json({ error: "This assessment has no facts to render yet." }, { status: 422 });
    }

    // The dedicated EmoWave-styled renderer (matches the reference report's
    // page order/layout) also covers Mind-Report-only clients now — several
    // of its sections (Note 1/2, Frequent/Core Emotion, Stress type) fall
    // back to that report's own equivalent fields when there's no
    // iEmoWave-Full upload, so it only drops to the plain generic template
    // when there's literally neither (e.g. Emotional Notes-only clients).
    const hasEwFull = assessment.facts.some((f) => f.sourceReport === "iEmoWave Full");
    const hasMindReport = assessment.facts.some((f) => f.sourceReport === "Aquera Mind Report");

    // No paywall gating wired up yet — every section renders in full for now.
    // `theme` is ignored for the generic (non-EmoWave) template — it has no
    // section-level structure to filter, so it always renders in full.
    // The generic template has no section-level structure to condense, so
    // there's no overview form of it — better to say so than to silently
    // hand back a multi-page report when a one-page overview was asked for.
    if (variant === "overview" && !hasEwFull && !hasMindReport) {
      return NextResponse.json(
        { error: "The one-page overview needs an iEmoWave Full or Aquera Mind Report upload for this client." },
        { status: 422 },
      );
    }
    // FWM keys every one of its sections off Mind-Report/iEmoWave values
    // (character types, sensory triples, note pair, stress score), so with
    // neither upload there is nothing to look up and the report would render
    // as a page of gaps.
    if (variant === "fwm" && !hasEwFull && !hasMindReport) {
      return NextResponse.json(
        { error: "The FWM report needs an iEmoWave Full or Aquera Mind Report upload for this client." },
        { status: 422 },
      );
    }

    const html =
      variant === "fwm"
        ? await renderFwmReportHtml(assessment, refreshOverview)
        : hasEwFull || hasMindReport
          ? await renderEwFullReportHtml(assessment, theme, variant)
          : renderReportHtml(assessment);
    // FWM is the only report with a running header/footer (and page numbers)
    // repeated on every page; the others keep the plain 20px frame.
    const pdf = await htmlToPdf(html, variant === "fwm" ? fwmPdfChrome(assessment) : undefined);

    const nameParts = ["emowave", variant === "full" ? "report" : variant, idParam, variant === "fwm" ? null : theme].filter(Boolean);
    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${nameParts.join("-")}.pdf"`,
        // The preview iframe reuses this exact URL every time a report is
        // reopened — without this, the browser can silently serve a stale
        // cached PDF from before the latest data/template change instead of
        // regenerating, which reads as "the fix didn't work" when it did.
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Report PDF generation failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
