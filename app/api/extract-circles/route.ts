import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { extractCircledText } from "@/lib/extractCircled";
import { EXTRACTIONS_DIR } from "@/lib/saveText";

// Node runtime (Buffer + fs are not supported on the Edge runtime).
export const runtime = "nodejs";

function safeBaseName(fileName: string) {
  const base = path.basename(fileName).replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[^a-zA-Z0-9-_ ]/g, "_").trim();
  return cleaned.slice(0, 60) || "document";
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
    const marks = await extractCircledText(bytes);

    // Save a plain-text copy alongside the Gemini extractions, same naming scheme.
    const when = new Date();
    const stamp = when.toISOString().replace(/[:.]/g, "-");
    const textPath = path.join(EXTRACTIONS_DIR, `${stamp}-${safeBaseName(file.name)}-circled.txt`);

    const lines = [
      `Source PDF: ${file.name}`,
      `Extracted:  ${when.toISOString()}`,
      `Total marks found: ${marks.length}`,
      "",
      "=" .repeat(70),
      "",
    ];
    for (const m of marks) {
      lines.push(`[Page ${m.page}, mark ${m.index}]`, m.text, "");
    }

    await mkdir(EXTRACTIONS_DIR, { recursive: true });
    await writeFile(textPath, lines.join("\r\n"), "utf8");

    return NextResponse.json({ ok: true, marks, textFile: textPath });
  } catch (err) {
    console.error("Circle extraction failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
