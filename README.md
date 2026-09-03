# PDF Extractor (Next.js + Gemini API + Prisma/SQLite)

Upload a fixed-layout PDF → Gemini extracts the **name** and the **table** → the data is
saved to a local **SQLite** database → shown on the page.

---

## What you need first: install Node.js

Node.js isn't installed on this machine yet. Install it once:

1. Go to <https://nodejs.org/> and download the **LTS** installer for Windows.
2. Run the installer (accept the defaults — keep "Add to PATH" checked).
3. **Close and reopen** your terminal, then check it worked:

   ```powershell
   node --version
   npm --version
   ```

   Both should print a version number.

---

## Setup (run once)

Open a terminal in this folder (`C:\ecowave`) and run:

```powershell
# 1. Install dependencies
npm install

# 2. Add your Google Gemini API key
#    Open .env.local and replace REPLACE_ME with your real key.
#    Get a key at https://aistudio.google.com/apikey

# 3. Create the database tables
npm run db:push
```

## Run the app

```powershell
npm run dev
```

Then open <http://localhost:3000> in your browser, pick a PDF, and click **Extract & Save**.

---

## Customizing for YOUR PDF

The default assumes a table with `item / quantity / price` columns. To match your real PDF:

1. Edit the schema in **`lib/gemini.ts`** (`EXTRACTION_SCHEMA`) — change the columns.
2. Edit **`prisma/schema.prisma`** (the `Row` model) to the same columns.
3. Update the `<table>` headers/cells in **`app/page.tsx`**.
4. Run `npm run db:push` again to update the database.

## Useful commands

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Start the app (development)                    |
| `npm run db:push`   | Apply `schema.prisma` changes to the database  |
| `npm run db:studio` | Open a visual DB browser at localhost:5555     |

## Project structure

```
app/
  page.tsx              Upload UI + list of saved records
  layout.tsx            Root layout
  globals.css           Styles
  api/
    extract/route.ts    PDF -> Gemini -> database
    records/route.ts    List saved records
lib/
  gemini.ts             Gemini client + extraction schema
  db.ts                 Prisma client
prisma/
  schema.prisma         Database tables
```

## Notes

- PDF limits: ~20 MB per inline request, 1000 pages per document.
- The SQLite database is a single file at `prisma/dev.db`. Delete it to start fresh.
- `.env` / `.env.local` are git-ignored so your key is never committed.
