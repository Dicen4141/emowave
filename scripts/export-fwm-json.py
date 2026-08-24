# Converts the vendor's four FWM workbooks into the JSON that
# import-fwm-reference-data.mjs upserts into the fwm_* tables. Same split as
# the original reference-data import (see import-reference-data.mjs): Python
# reads Excel, Node writes the database, so openpyxl never becomes a runtime
# dependency of the app.
#
#   python scripts/export-fwm-json.py <drive-folder> [out-dir]
#
# Re-runnable and non-destructive — it only writes JSON files.
import json
import sys
from pathlib import Path

import openpyxl

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "drive-download-20260817T025247Z-1-001")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "scripts/fwm-data")
OUT.mkdir(parents=True, exist_ok=True)

STRESS = "v1.0- DataStress_FWM.xlsx"
CHARACTERISTICS = "v1.0_Characteristics_FWM_DataSet.xlsx"
EQ = "v1.1-EQ_Behaviour.xlsx"


def clean(v):
    """Vendor cells were authored in Word and pasted in, so smart quotes arrive
    as U+FFFD. Blank-ish cells become None so Postgres stores NULL, not ""."""
    if v is None:
        return None
    s = str(v).replace("�", "'").strip()
    return s or None


def rows(filename, sheet):
    ws = openpyxl.load_workbook(SRC / filename, data_only=True)[sheet]
    raw = [r for r in ws.iter_rows(values_only=True) if any(c not in (None, "") for c in r)]
    header = [str(c).strip() if c is not None else "" for c in raw[0]]
    out = []
    for r in raw[1:]:
        rec = {header[i]: r[i] for i in range(len(header)) if header[i]}
        if any(v not in (None, "") for v in rec.values()):
            out.append(rec)
    return out


def write(name, records):
    (OUT / f"{name}.json").write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  {name}.json  {len(records)} rows")


print(f"Reading {SRC} -> {OUT}")

write("fwm_stress_range", [
    {
        "stressFrom": float(r["Stress - From"]),
        "stressTo": float(r["Stress-To"]),
        "general": clean(r.get("General")),
        "indicator": clean(r.get("Indicator")),
        "financialIntelligence": clean(r.get("Financial Intelligence")),
        "childrenIntelligence": clean(r.get("Children Intelligence")),
    }
    for r in rows(STRESS, "All_Stress_Types")
])

write("fwm_present_character", [
    {
        "type": int(r["Type"]),
        "character": clean(r["Character"]),
        "presentCharacter": clean(r.get("Present Character")),
        "summary": clean(r.get("Summary")),
        "financialPersonality": clean(r.get("Financial Personality in via from others")),
        "subconsciousMoneyBehaviors": clean(r.get("Subconscious Money Behaviors & Triggers")),
        "potentialFinanceChallenges": clean(r.get("Potential Finance Challenges")),
        "coachingPathway": clean(r.get("Targeted Financial Wellness Coaching Pathway")),
        "workEnvironment": clean(r.get("Work Environment (Base)")),
        "growPath": clean(r.get("Grow Path")),
        "personalityStyle": clean(r.get("Personality Style (MHA)")),
        "badHabits": clean(r.get("Bad habits")),
        "socialInfluence": clean(r.get("Social Influence")),
        "talents": clean(r.get("Talents and Expertise")),
        "physicalHealth": clean(r.get("Possible Physical Health Issue")),
    }
    for r in rows(CHARACTERISTICS, "Present Characters")
])

write("fwm_real_intention", [
    {
        "type": int(r["Type"]),
        "character": clean(r["Character"]),
        "realIntention": clean(r.get("Real Intention")),
        "summary": clean(r.get("Summary")),
        "idealWorkplace": clean(r.get("Ideal Workplace")),
        "growPath": clean(r.get("Grow Path")),
        "motivateYourself": clean(r.get("Motivate Yourself")),
        "definingChallenge": clean(r.get("Defining the Challenge")),
        "coreValues": clean(r.get("Creating Your Core Values")),
        "possibleCareer": clean(r.get("Possible Career")),
        "coachingPathway": clean(r.get("Targeted Financial Wellness Coaching Pathway")),
    }
    for r in rows(CHARACTERISTICS, "Real Intention")
])

# Rows whose pairing key is blank are spacers, not data — the sheet ends with
# one. Dropping them here keeps the @@id([presentCharacter, realIntention])
# upsert from failing on an empty key.
write("fwm_combination", [
    {
        "presentCharacter": clean(r["Present Character"]),
        "realIntention": clean(r["Real Intention"]),
        "financialBehaviourPattern": clean(r.get("Financial Behaviour Pattern")),
        "careerThoughtProcess": clean(r.get("Career in your thought process")),
    }
    for r in rows(CHARACTERISTICS, "Combination")
    if clean(r.get("Present Character")) and clean(r.get("Real Intention"))
])

write("fwm_comm_learn", [
    {
        "base": clean(r["Base"]),
        "communicationStyle": clean(r.get("Communication Style")),
        "learningStyle": clean(r.get("Learning Style")),
    }
    for r in rows(STRESS, "Comm_Learn")
])

write("fwm_decision_making", [
    {
        "baseNext": clean(r["Base - Next Combinations"]),
        "decisionMaking": clean(r.get("Decision making")),
        "financialChoice": clean(r.get("Financial Choice")),
    }
    for r in rows(STRESS, "Decision_Making")
])

write("fwm_note_combination", [
    {
        "note1": clean(r["Note 1"]),
        "note2": clean(r["Note 2"]),
        "behaviorPattern": clean(r.get("Behavior Pattern")),
        "financialBehavior": clean(r.get("Financial Behavior")),
    }
    for r in rows(EQ, "CombineMusicalNote")
])

print("Done.")
