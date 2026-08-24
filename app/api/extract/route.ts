import { NextResponse } from "next/server";
import { gemini, MODEL, EXTRACTION_SCHEMA, type Extracted } from "@/lib/gemini";
import { saveExtractionText } from "@/lib/saveText";
import { makeFilledPdf } from "@/lib/makePdf";
import { prisma } from "@/lib/db";

// Node runtime (Prisma + Buffer are not supported on the Edge runtime).
export const runtime = "nodejs";

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

    // Optional: only extract the part of the document the user asked for.
    const targetRaw = formData.get("target");
    const target = typeof targetRaw === "string" ? targetRaw.trim() : "";

    // PDF -> base64 (no newlines, as the API requires).
    const bytes = Buffer.from(await file.arrayBuffer());
    const base64 = bytes.toString("base64");

    // Shared formatting rules, used whether we transcribe all or just one part.
    const formattingRules =
      "Format `fullText` as clean, well-formatted Markdown: reconstruct the real " +
      "layout with every heading, clause, list item and form field on its own line, " +
      "a blank line between paragraphs, and any tables as Markdown tables. Keep the " +
      "wording verbatim — do not summarise or reword — but DO add the line breaks and " +
      "spacing so it reads like the original document, not one long run-on line. Join " +
      "words that were split across a line break in the source.";

    const promptText = target
      ? // Targeted: pull out only the requested part.
        `From this document, extract ONLY the part the user asked for: "${target}".\n\n` +
        "Put just that part — its heading and its content — into `fullText`. Ignore " +
        "everything else in the document. If the requested part appears more than once, " +
        "include every occurrence. If you cannot find it anywhere in the document, set " +
        "`fullText` to exactly: NOT FOUND\n\n" +
        formattingRules +
        "\n\nAlso set `name` to a short label for the part you extracted, and `table` to " +
        "rows of any table inside that part (empty array if none).\n\n" +
        "Return the data strictly following the provided JSON schema."
      : // Default: transcribe the whole document.
        "Transcribe this document COMPLETELY into `fullText`.\n\n" +
        "IMPORTANT: the file may contain MULTIPLE pages and several separate " +
        "sub-documents (e.g. a contract, an NDA, a form). Transcribe EVERY page " +
        "and EVERY sub-document, from the very first page to the very last. Do " +
        "not stop after the first section.\n\n" +
        formattingRules +
        "\n\nAlso fill in `name` (the document's title) and `table` (rows of the main " +
        "table, if it has one — leave it as an empty array if it does not).\n\n" +
        "Return the data strictly following the provided JSON schema. " +
        "If a cell is empty, use an empty string.";

    // Ask Gemini to extract the requested content as structured JSON.
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "application/pdf",
                data: base64,
              },
            },
            { text: promptText },
          ],
        },
      ],
      config: {
        // A full transcription is far longer than the old name+table output.
        maxOutputTokens: 65536,
        responseMimeType: "application/json",
        responseSchema: EXTRACTION_SCHEMA,
      },
    });

    // With structured output, the response text is guaranteed valid JSON.
    const text = response.text;
    if (!text) {
      return NextResponse.json(
        {
          error: "Model did not return text.",
          finish_reason: response.candidates?.[0]?.finishReason,
        },
        { status: 502 },
      );
    }

    // A truncated response isn't valid JSON, so report it clearly rather than
    // failing later with an opaque parse error.
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== "STOP") {
      return NextResponse.json(
        { error: `Model stopped early (${finish}). The PDF may be too long to transcribe in one request.` },
        { status: 502 },
      );
    }

    const data = JSON.parse(text) as Extracted;

    // If a specific part was requested but not found, don't save an empty record.
    if (target && data.fullText.trim() === "NOT FOUND") {
      return NextResponse.json(
        { error: `Couldn't find "${target}" in this document. Try different wording, or leave the box blank to extract everything.` },
        { status: 404 },
      );
    }

    // Write the plain-text copy FIRST, so a failed DB write still leaves a record.
    const textFile = await saveExtractionText(data, file.name);

    // Build the filled template PDF alongside it, sharing the same base name.
    const pdfFile = await makeFilledPdf(data, file.name, textFile.replace(/\.txt$/, ".pdf"));

    // Save to the database: one Document with its Rows (nested create).
    const saved = await prisma.document.create({
      data: {
        name: data.name,
        fileName: file.name,
        rows: {
          create: data.table.map((r) => ({
            item: r.item,
            quantity: r.quantity,
            price: r.price,
          })),
        },
      },
      include: { rows: true },
    });

    return NextResponse.json({ ok: true, document: saved, textFile, pdfFile });
  } catch (err) {
    console.error("Extraction failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
