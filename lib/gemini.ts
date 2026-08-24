import { GoogleGenAI, Type } from "@google/genai";

// Reads GEMINI_API_KEY from the environment (.env.local).
export const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// gemini-3.5-flash / gemini-flash-latest were returning 503 (overloaded) as of
// 2026-07-16; flash-lite handles this fixed-layout extraction just as accurately.
export const MODEL = "gemini-3.1-flash-lite";

// Client-facing prose (the FWM report's opening overview) rather than
// structured extraction. flash-lite was picked above for pulling fixed fields
// out of a fixed layout, which is not the same job as writing four paragraphs
// someone will read — so this is its own constant, overridable per environment
// without touching the extraction path. Defaults to MODEL so an unset variable
// still uses a model this project is known to have access to.
export const PROSE_MODEL = process.env.GEMINI_PROSE_MODEL || MODEL;

// ---------------------------------------------------------------------------
// Schema describing exactly what we want Gemini to pull out of the PDF.
// Because the PDF layout is fixed, structured output makes extraction reliable.
// 👉 CHANGE the `table.items.properties` to match YOUR pdf's table columns,
//    and keep prisma/schema.prisma's `Row` model in sync.
// `propertyOrdering` matters: it fixes the key order the model generates in.
// ---------------------------------------------------------------------------
export const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: {
      type: Type.STRING,
      description: "The name shown near the top / front of the document",
    },
    fullText: {
      type: Type.STRING,
      description:
        "The COMPLETE text of the document as clean, readable Markdown. Rules:\n" +
        "- The file may hold MULTIPLE pages and several separate sub-documents; " +
        "transcribe ALL of them, first page to last. Omit nothing: headings, field " +
        "labels AND their filled-in values, body text, checkboxes ([x]/[ ]), " +
        "signatures, dates, footers, page numbers and fine print.\n" +
        "- Use REAL line breaks. Put each heading, list item, numbered clause and " +
        "field on its own line. Separate paragraphs with a blank line. Never run " +
        "the whole document together into one line.\n" +
        "- Use '# ' / '## ' for section headings and titles.\n" +
        "- Render tables as GitHub Markdown tables (| col | col |).\n" +
        "- Put a 'Label: value' pair on its own line for form fields.\n" +
        "- Fix words that were split across a line break in the source (e.g. " +
        "'for\\nCompany' becomes 'for Company'), but do not otherwise reword, " +
        "summarise or add anything. The wording must stay verbatim.",
    },
    table: {
      type: Type.ARRAY,
      description: "Every row of the main table in the document",
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING, description: "Item / description column" },
          quantity: { type: Type.STRING, description: "Quantity column" },
          price: { type: Type.STRING, description: "Price / amount column" },
        },
        propertyOrdering: ["item", "quantity", "price"],
        required: ["item", "quantity", "price"],
      },
    },
  },
  // fullText comes before table so the model transcribes the document before
  // trying to fit anything into the table's columns.
  propertyOrdering: ["name", "fullText", "table"],
  required: ["name", "fullText", "table"],
};

// Shape of the parsed result, for TypeScript.
export type Extracted = {
  name: string;
  fullText: string;
  table: { item: string; quantity: string; price: string }[];
};
