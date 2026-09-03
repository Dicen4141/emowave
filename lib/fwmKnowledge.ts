import { buildFwmGroups } from "./renderFwmReport";
import type { AssessmentWithFacts } from "./renderEwFullReport";

/**
 * The Financial (FWM) report as plain text, for the knowledge base Quantemo's
 * chat answers from.
 *
 * Why this exists: buildClientDataSummary covers the EmoWave report only. A
 * customer who bought the Financial report could open its chat and ask about
 * Life Stressors, Financial Character Assessment or Underlying Drivers of
 * Financial Objectives — every one of which is a real section they had just
 * paid to read — and be told it wasn't in the data, because none of the FWM
 * reference tables ever reached the summary.
 *
 * Built from buildFwmGroups(), the same function that renders the PDF, so the
 * two cannot describe different sections. Section and block titles are kept
 * VERBATIM from the report: the customer is reading those exact headings on
 * the page in front of them, and a question is usually a heading typed back.
 */
export async function buildFwmSummary(assessment: AssessmentWithFacts): Promise<string> {
  const { mha, ema, env } = await buildFwmGroups(assessment);

  const sections: [string, Awaited<ReturnType<typeof buildFwmGroups>>["mha"]][] = [
    ["Mental Health Assessment (MHA)", mha],
    ["Emotional Analysis (EMA)", ema],
    ["Environmental Factors (ENV)", env],
  ];

  const lines: string[] = [];
  for (const [sectionTitle, groups] of sections) {
    for (const group of groups) {
      // An empty body means the workbook ships no row for this client's
      // combination (e.g. the 19 "Seeker" pairings). The report renders that
      // as a gap; here the block is simply omitted, so the chat says the
      // section isn't covered rather than quoting an empty heading as content.
      const blocks = group.blocks.filter((b) => b.body && b.body.trim());
      if (blocks.length === 0) continue;
      lines.push(`[Financial Report — ${sectionTitle} — ${group.title}]`);
      if (group.blurb?.trim()) lines.push(`  ${group.blurb.trim()}`);
      for (const b of blocks) {
        // Newlines inside a body would break the one-fact-per-line shape the
        // rest of the summary uses, so they collapse to a separator.
        lines.push(`  ${b.title}: ${b.body.trim().replace(/\s*\n+\s*/g, " / ")}`);
      }
    }
  }

  if (lines.length === 0) return "";
  return ["FINANCIAL (FWM) REPORT", ...lines].join("\n");
}
