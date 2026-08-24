# Renders one filled Financial Wealth Management (FWM) report straight from the
# vendor's four v1.0/v1.1 workbooks, using a real client profile as the input.
#
# This is a *presentation prototype*, not the production path: it proves the
# docx mapping spec resolves against the real data before any Prisma models or
# import scripts get written. Every rendered block carries a provenance badge
# (file -> sheet -> column) so the mapping can be checked by eye.
#
#   python scripts/build-fwm-sample.py <drive-folder> <output.html>
#
# Reading Excel isn't a project dependency (see import-reference-data.mjs) —
# openpyxl is only needed for this offline prototype.
import html
import sys
from pathlib import Path

import openpyxl

DRIVE = Path(sys.argv[1] if len(sys.argv) > 1 else "drive-download-20260817T025247Z-1-001")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "fwm-sample-report.html")

STRESS_FWM = "v1.0- DataStress_FWM.xlsx"
CHARACTERISTICS = "v1.0_Characteristics_FWM_DataSet.xlsx"
EQ_BEHAVIOUR = "v1.1-EQ_Behaviour.xlsx"

# ---------------------------------------------------------------------------
# Client profile — derived from extractions/2026-08-14T09-45-32-659Z-4-Peng
# Piaw Foong - Raw Mind Report-facts.txt. Notes are normalised the same way
# normalizeNote() in lib/renderEwFullReport.ts does it: the parenthesised
# vendor code wins, and a flat folds to the SAME LETTER's sharp — this
# client's convention, not standard Western enharmonics, so
# "D flat -Major (Db)" is D#, not the C# music theory would call it.
CLIENT = {
    "name": "Peng Piaw Foong",
    "date": "14 August 2026",
    "number": "4",
    "stress_index": 15.0,            # "Stress index value" = 15
    "present_character": "Helper",   # "Sensory personality mode (Base)" = The Helper (2)
    "real_intention": "Winner",      # "Sensory personality mode (Next)" = The Winner (3.2)
    "base_sensory": "FEELING + Outward + Extrovert",
    "next_sensory": "VISUAL + Outward + Extrovert",
    "note1": "E",                    # Public Self  — E-Minor (Em)
    "note2": "D#",                   # Private Self — D flat -Major (Db)
    "frequent_emotion_code": "i2",   # "Introvert and insecure."
    "core_emotion_code": "d1",       # "Difficulties being alone."
}


def sheet_rows(filename, sheet):
    """Non-empty rows of a sheet as list-of-dicts keyed by the header row."""
    ws = openpyxl.load_workbook(DRIVE / filename, data_only=True)[sheet]
    rows = [r for r in ws.iter_rows(values_only=True) if any(c not in (None, "") for c in r)]
    header = [str(c).strip() if c is not None else "" for c in rows[0]]
    out = []
    for raw in rows[1:]:
        rec = {header[i]: raw[i] for i in range(len(header)) if header[i]}
        # Trailing all-blank spacer rows exist in Combination; drop them.
        if any(v not in (None, "") for v in rec.values()):
            out.append(rec)
    return out


def find(rows, criteria):
    """First row matching every column=value pair. Column names come from the
    vendor's own headers, which include dots ("No.") and ampersands, so they're
    passed as a dict rather than keyword arguments."""
    for rec in rows:
        if all(str(rec.get(k) or "").strip() == v for k, v in criteria.items()):
            return rec
    return None


def text(value):
    """Vendor cells carry cp1252 smart quotes that arrive as U+FFFD."""
    if value is None:
        return ""
    return str(value).replace("�", "'").strip()


# ---------------------------------------------------------------------------
# Resolve every lookup the docx spec calls for.
stress_rows = sheet_rows(STRESS_FWM, "All_Stress_Types")
stress = next(
    r for r in stress_rows
    if float(r["Stress - From"]) <= CLIENT["stress_index"] < float(r["Stress-To"])
)

present = find(sheet_rows(CHARACTERISTICS, "Present Characters"), {"Character": CLIENT["present_character"]})
intention = find(sheet_rows(CHARACTERISTICS, "Real Intention"), {"Character": CLIENT["real_intention"]})
combination = find(
    sheet_rows(CHARACTERISTICS, "Combination"),
    {"Present Character": CLIENT["present_character"], "Real Intention": CLIENT["real_intention"]},
)

emotions = sheet_rows(EQ_BEHAVIOUR, "Frequent_Core_Emotion")
frequent = find(emotions, {"No.": CLIENT["frequent_emotion_code"]})
core = find(emotions, {"No.": CLIENT["core_emotion_code"]})
notes = sheet_rows(EQ_BEHAVIOUR, "Musical_Notes")
note1_ref = find(notes, {"Note": CLIENT["note1"]})
note2_ref = find(notes, {"Note": CLIENT["note2"]})
combined_note = find(
    sheet_rows(EQ_BEHAVIOUR, "CombineMusicalNote"),
    {"Note 1": CLIENT["note1"], "Note 2": CLIENT["note2"]},
)

comm = find(sheet_rows(STRESS_FWM, "Comm_Learn"), {"Base": CLIENT["base_sensory"]})
decision = find(
    sheet_rows(STRESS_FWM, "Decision_Making"),
    {"Base - Next Combinations": f'{CLIENT["base_sensory"]} - {CLIENT["next_sensory"]}'},
)

# Every lookup above must hit — a miss means the mapping spec is wrong, and
# silently rendering an empty section would hide that.
for label, rec in [
    ("stress band", stress), ("present character", present), ("real intention", intention),
    ("combination", combination), ("frequent emotion", frequent), ("core emotion", core),
    ("note 1", note1_ref), ("note 2", note2_ref), ("combined note", combined_note),
    ("communication/learning", comm), ("decision making", decision),
]:
    if rec is None:
        raise SystemExit(f"Unresolved lookup: {label}")


# ---------------------------------------------------------------------------
def block(title, value, source, note=None):
    """One mapped field: heading, vendor copy, and its provenance badge."""
    if not text(value):
        return (
            f'<div class="block missing"><h4>{html.escape(title)}</h4>'
            f'<p class="gap">No data in the source workbook.</p>'
            f'<div class="src">{html.escape(source)}</div></div>'
        )
    paras = "".join(
        f"<p>{html.escape(p.strip())}</p>" for p in text(value).split("\n") if p.strip()
    )
    extra = f'<p class="note">{html.escape(note)}</p>' if note else ""
    return (
        f'<div class="block"><h4>{html.escape(title)}</h4>{paras}{extra}'
        f'<div class="src">{html.escape(source)}</div></div>'
    )


def gap(title, reason):
    """A field the template asks for that no workbook supplies. Rendered rather
    than skipped, so the hole stays visible instead of silently vanishing."""
    return (
        f'<div class="block missing"><h4>{html.escape(title)}</h4>'
        f'<p class="gap">{html.escape(reason)}</p></div>'
    )


def group(title, blurb, blocks):
    """A topic line from the template (e.g. "Financial Character Assessment:")
    and the bulleted fields sitting under it. The docx nests two levels deep —
    Heading4 section, then these — so the report does too."""
    sub = f'<p class="group-blurb">{html.escape(blurb)}</p>' if blurb else ""
    return f'<div class="group"><h3>{html.escape(title)}</h3>{sub}{"".join(blocks)}</div>'


def section(num, title, blurb, groups):
    return f"""<section>
  <h2><span class="num">{num}</span>{html.escape(title)}</h2>
  <p class="blurb">{html.escape(blurb)}</p>
  {"".join(groups)}
</section>"""


S_STRESS = "v1.0- DataStress_FWM.xlsx → All_Stress_Types"
S_PRESENT = "v1.0_Characteristics_FWM_DataSet.xlsx → Present Characters"
S_INTENT = "v1.0_Characteristics_FWM_DataSet.xlsx → Real Intention"
S_COMBO = "v1.0_Characteristics_FWM_DataSet.xlsx → Combination"
S_EMO = "v1.1-EQ_Behaviour.xlsx → Frequent_Core_Emotion"
S_NOTE = "v1.1-EQ_Behaviour.xlsx → CombineMusicalNote"
S_COMM = "v1.0- DataStress_FWM.xlsx → Comm_Learn"
S_DECIDE = "v1.0- DataStress_FWM.xlsx → Decision_Making"

# Group titles, their order, and the fields nested under each mirror the
# template's own outline (Heading4 -> topic line -> bullets). Topic-line
# wording is the template's, with the client's own values interpolated where
# it writes «present character» / «real intention» / «Base Sensory».
mha = [
    group("Life Stressors", "", [
        block("Indicator", stress["Indicator"], f'{S_STRESS} → "Indicator"'),
        block("Financial Intelligence", stress["Financial Intelligence"],
              f'{S_STRESS} → "Financial Intelligence"'),
    ]),
    group("Financial Character Assessment",
          f'How others perceive you as "{text(present["Present Character"])}".', [
        block(f'{text(present["Present Character"])} — Summary', present["Summary"],
              f'{S_PRESENT} → "Present Character" + "Summary"'),
        block("Financial Personality, as projected to others", present["Financial Personality in via from others"],
              f'{S_PRESENT} → "Financial Personality in via from others"'),
        block("Subconscious Money Behaviors & Triggers", present["Subconscious Money Behaviors & Triggers"],
              f'{S_PRESENT} → "Subconscious Money Behaviors & Triggers"'),
        block("Potential Finance Challenges", present["Potential Finance Challenges"],
              f'{S_PRESENT} → "Potential Finance Challenges"'),
    ]),
    group("Underlying Drivers of Financial Objectives",
          f'Your real intention: "{text(intention["Real Intention"])}".', [
        block("Summary", intention["Summary"], f'{S_INTENT} → "Summary"'),
        block("Creating Your Core Values", intention["Creating Your Core Values"],
              f'{S_INTENT} → "Creating Your Core Values"'),
        block("Motivate Yourself", intention["Motivate Yourself"], f'{S_INTENT} → "Motivate Yourself"'),
        block("Defining the Challenge", intention["Defining the Challenge"],
              f'{S_INTENT} → "Defining the Challenge"'),
        # The template reads 'Potential Career Paths ... "Grow Path"', but Grow
        # Path holds a transformation statement ("From fear to courage.") while
        # Possible Career holds actual careers. Both are shown pending a ruling.
        block("Potential Career Paths", intention["Possible Career"], f'{S_INTENT} → "Possible Career"',
              note="These are suggestions and require your own validation/acknowledgment."),
        block("Grow Path", intention["Grow Path"], f'{S_INTENT} → "Grow Path"'),
        block("Financial Behaviour Pattern", combination["Financial Behaviour Pattern"],
              f'{S_COMBO} → "Financial Behaviour Pattern"'),
        block("Career in Your Thought Process", combination["Career in your thought process"],
              f'{S_COMBO} → "Career in your thought process"'),
        # "Areas to be coached" is a bullet inside this group in the template,
        # not a heading of its own — it follows the Combination bullets with no
        # break, even though its data comes from the Present Characters sheet.
        block("Areas to be Coached — Targeted Financial Wellness Coaching Pathway",
              present["Targeted Financial Wellness Coaching Pathway"],
              f'{S_PRESENT} → "Targeted Financial Wellness Coaching Pathway"'),
    ]),
    group("Social Influence",
          "Understanding how peer behavior patterns affect an individual's financial habits.", [
        block("Social Influence", present["Social Influence"], f'{S_PRESENT} → "Social Influence"'),
    ]),
]

ema = [
    group("Emotional Intelligence (EQ)",
          "Measuring the foundational EQ that governs interpersonal financial relationships.", [
        block(f'Frequent Emotions — {text(frequent["Header"])}', frequent["Description"],
              f'{S_EMO} → "Description" (code {CLIENT["frequent_emotion_code"]})'),
        block(f'Core Emotions — {text(core["Header"])}', core["Description"],
              f'{S_EMO} → "Description" (code {CLIENT["core_emotion_code"]})'),
        block("Behavior Pattern", combined_note["Behavior Pattern"],
              f'{S_NOTE} → "Behavior Pattern" ({CLIENT["note1"]} + {CLIENT["note2"]})'),
        block("Financial Behavior", combined_note["Financial Behavior"],
              f'{S_NOTE} → "Financial Behavior" ({CLIENT["note1"]} + {CLIENT["note2"]})'),
    ]),
    group("Proficiency & Communication Style",
          f'Your base sensory: {CLIENT["base_sensory"]}.', [
        block("Communication Style", comm["Communication Style"], f'{S_COMM} → "Communication Style"'),
        block("Your Unique Learning Style", comm["Learning Style"], f'{S_COMM} → "Learning Style"'),
        # Same as "Areas to be coached": a bullet within this group, not its own
        # heading, and keyed on Base + Next rather than Base alone.
        block("Your Decision-Making Framework", decision["Decision making"], f'{S_DECIDE} → "Decision making"'),
        block("Financial Choice", decision["Financial Choice"], f'{S_DECIDE} → "Financial Choice"'),
    ]),
    group("Environmental Factors",
          "Tracking how the current financial environment influences the client's emotional state in real-time.", [
        gap("Environmental Factors",
            "Specified in the template, but no sheet or column in the four workbooks supplies it. "
            "Needs either a new data source or a live market/environment feed."),
    ]),
]

inputs_table = "".join(
    f"<tr><td>{html.escape(k)}</td><td>{html.escape(v)}</td></tr>"
    for k, v in [
        ("Stress index", f'{CLIENT["stress_index"]:g} → band [{stress["Stress - From"]:g}, {stress["Stress-To"]:g})'),
        ("Present Character", f'{CLIENT["present_character"]} (type {present["Type"]:g})'),
        ("Real Intention", f'{CLIENT["real_intention"]} (type {intention["Type"]:g})'),
        ("Base sensory", CLIENT["base_sensory"]),
        ("Next sensory", CLIENT["next_sensory"]),
        ("Note 1 / Note 2", f'{CLIENT["note1"]} ({text(note1_ref["Music Note"])}) + {CLIENT["note2"]} ({text(note2_ref["Music Note"])})'),
        ("Frequent / Core emotion", f'{CLIENT["frequent_emotion_code"]} / {CLIENT["core_emotion_code"]}'),
    ]
)

HTML = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EmoWave 5.0 — FWM Report — {html.escape(CLIENT["name"])}</title>
<style>
  :root {{ --ink:#1a1a2e; --muted:#6b7280; --line:#e5e7eb; --accent:#7b5ea7; --accent2:#c23b7a; --bg:#fff; --card:#faf9fc; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; font:16px/1.65 Roboto,-apple-system,Segoe UI,sans-serif; color:var(--ink); background:#f3f4f6; }}
  .page {{ max-width:900px; margin:0 auto; background:var(--bg); padding:0 0 64px; }}
  header {{ background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; padding:48px 56px; }}
  header .brand {{ font:600 34px/1.2 Montserrat,sans-serif; letter-spacing:.5px; }}
  header .tag {{ opacity:.9; margin:6px 0 26px; }}
  header .meta {{ display:flex; flex-wrap:wrap; gap:32px; font-size:14px; }}
  header .meta div span {{ display:block; opacity:.75; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }}
  main {{ padding:0 56px; }}
  .summary {{ background:var(--card); border-left:4px solid var(--accent); padding:20px 24px; margin:36px 0; border-radius:0 6px 6px 0; }}
  .summary h3 {{ margin:0 0 8px; font:600 17px Montserrat,sans-serif; }}
  .summary .todo {{ color:var(--muted); font-style:italic; font-size:14px; }}
  h2 {{ font:600 22px Montserrat,sans-serif; margin:48px 0 4px; padding-bottom:10px; border-bottom:2px solid var(--line); }}
  h2 .num {{ display:inline-grid; place-items:center; width:30px; height:30px; margin-right:12px; border-radius:50%;
             background:var(--accent); color:#fff; font-size:14px; vertical-align:middle; }}
  .blurb {{ color:var(--muted); font-size:14px; margin:0 0 8px; }}
  .group {{ margin:28px 0 0; padding-left:20px; border-left:3px solid #ede9f4; }}
  .group h3 {{ font:600 17px Montserrat,sans-serif; margin:0 0 4px; color:var(--accent2); }}
  .group-blurb {{ color:var(--muted); font-size:13.5px; font-style:italic; margin:0; }}
  .block {{ border:1px solid var(--line); border-radius:8px; padding:18px 20px; margin:16px 0; background:var(--bg); }}
  .block h4 {{ margin:0 0 8px; font:600 15px Montserrat,sans-serif; color:var(--accent); }}
  .block p {{ margin:0 0 10px; }} .block p:last-of-type {{ margin-bottom:0; }}
  .block .note {{ font-size:13px; color:var(--muted); font-style:italic; }}
  .block.missing {{ border-style:dashed; border-color:#f0a; background:#fff5fa; }}
  .gap {{ color:#c0006e; font-weight:600; }}
  .src {{ margin-top:12px; padding-top:10px; border-top:1px dashed var(--line);
          font:12px/1.4 "Courier Prime",ui-monospace,monospace; color:var(--muted); word-break:break-word; }}
  table {{ width:100%; border-collapse:collapse; margin:16px 0; font-size:14px; }}
  td {{ border-bottom:1px solid var(--line); padding:8px 10px; }}
  td:first-child {{ color:var(--muted); width:38%; }}
  .inputs {{ background:var(--card); border-radius:8px; padding:8px 20px 16px; margin:24px 0; }}
  .inputs h3 {{ font:600 15px Montserrat,sans-serif; margin:16px 0 0; }}
  footer {{ margin:56px 56px 0; padding-top:20px; border-top:1px solid var(--line); font-size:13px; color:var(--muted); }}
  @media print {{ body {{ background:#fff; }} .page {{ max-width:none; }} .src {{ display:none; }} }}
</style></head><body><div class="page">
<header>
  <div class="brand">EMOWAVE 5.0</div>
  <div class="tag">An AI-powered automated analytics application</div>
  <div class="meta">
    <div><span>Type</span>Financial Wealth Management (FWM)</div>
    <div><span>Name</span>{html.escape(CLIENT["name"])}</div>
    <div><span>Date</span>{html.escape(CLIENT["date"])}</div>
    <div><span>No.</span>{html.escape(CLIENT["number"])}</div>
  </div>
</header>
<main>
  <div class="summary">
    <h3>Analytic and Emotional Power for Financial Success</h3>
    <p class="todo">AI-generated overview, composed from every section below. Not yet wired up — the
    template spec calls for it but supplies no source data, so it stays a placeholder in this prototype.</p>
  </div>

  <div class="inputs">
    <h3>Client inputs driving this report</h3>
    <table><tbody>{inputs_table}</tbody></table>
  </div>

  {section("1", "Mental Health Assessment (MHA)",
           "Identifying the psychological states that drive financial behavior.", mha)}

  {section("2", "Emotional Analysis (EMA)",
           "Identifying and interpreting emotional patterns is vital for maintaining mental health "
           "during turbulent market cycles.", ema)}
</main>
<footer>
  Prototype rendered from v1.0/v1.1 workbooks by <code>scripts/build-fwm-sample.py</code>.
  Section order and nesting follow <em>v1.0-Emowave-FWM Report.docx</em>. Each block cites the
  workbook, sheet and column it came from; all copy is the vendor's own, unedited. Blocks outlined
  in dashed pink are specified by the template but have no source data.
</footer>
</div></body></html>"""

OUT.write_text(HTML, encoding="utf-8")
print(f"Wrote {OUT}  ({len(HTML):,} bytes)")
print(f"Resolved: stress band [{stress['Stress - From']:g},{stress['Stress-To']:g}), "
      f"{CLIENT['present_character']}+{CLIENT['real_intention']}, "
      f"notes {CLIENT['note1']}+{CLIENT['note2']}")
