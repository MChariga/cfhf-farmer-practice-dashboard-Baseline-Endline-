"""
rebuild_from_raw.py
====================
Rebuilds dashboard_data.js directly from Endline_Data_Pilot.xlsx (the true
original raw data - one row per farmer per assessment round per day, plus
an Endline_Qual. sheet for tenure), instead of from the already-cleaned
Day_one.xlsx...Day_Five.xlsx workbooks that build_dashboard_data.py used
before.

Why: those cleaned workbooks turned out to already exclude farmers who
were not found at endline (nBaselineSurveyed == nEndlineSurveyed on every
day in the old dashboard_data.js - a dead giveaway), and used a
Name+Organization+County farmer key which silently splits real farmers
into two when their name is spelled two different ways across sheets. The
raw file's Farmer_ID does not have that problem.

What this keeps from the old pipeline: question short labels, question
text, and non-adoption reasonCategory strings are not present in the raw
file, so they are carried over from the previous dashboard_data.js keyed
by (day, question, normalized farmer name) - best-effort, since only a
handful of names differ in spelling between the two sources.
"""

import json
import re
import datetime as dt

import numpy as np
import pandas as pd

RAW_FILE = "Endline_Data_Pilot.xlsx"
OLD_DASHBOARD_JS = "dashboard_data.js"
OUT_FILE = "dashboard_data.js"

DATA_SOURCE = "Kenya AE Hub, CFHF Project Evaluation Data, 2025/26"

TENURE_REFERENCE_DATE = dt.date(2026, 1, 1)
TENURE_THRESHOLD_YEARS = 1.5

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
SEASON_MONTH_HINT = {"early": 2, "mid": 6, "late": 11}


def _years_between(d, ref=TENURE_REFERENCE_DATE):
    return (ref - d).days / 365.25


def classify_tenure(raw):
    """Unchanged from build_dashboard_data.py."""
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return None, "Unknown"

    if isinstance(raw, (dt.datetime, dt.date)):
        d = raw.date() if isinstance(raw, dt.datetime) else raw
        yrs = _years_between(d)
        return round(yrs, 2), ("Old" if yrs > TENURE_THRESHOLD_YEARS else "New")

    if isinstance(raw, (int, float)):
        year = int(abs(raw))
        if 1900 < year < 2100:
            yrs = _years_between(dt.date(year, 7, 1))
            return round(yrs, 2), ("Old" if yrs > TENURE_THRESHOLD_YEARS else "New")
        return None, "Unknown"

    s = str(raw).strip()
    if not s:
        return None, "Unknown"
    low = s.lower()

    if re.search(r"\bnot\s+new\b", low):
        return None, "Old"
    if re.search(r"\bnew\s+(farmer|member)s?\b", low):
        return None, "New"
    if re.search(r"\bold\s+mem\w*", low):
        return None, "Old"

    m = re.search(r"(\d+(?:\.\d+)?)\s*year", low)
    if m:
        yrs = float(m.group(1))
        return yrs, ("Old" if yrs > TENURE_THRESHOLD_YEARS else "New")

    month = None
    for word, num in SEASON_MONTH_HINT.items():
        if word in low:
            month = num
            break
    m_month = re.search(r"([a-zA-Z]+)\.?\s+(\d{4})", low)
    if month is None and m_month and m_month.group(1) in MONTHS:
        month = MONTHS[m_month.group(1)]

    m_year = re.search(r"(19|20)\d{2}", low)
    if not m_year:
        return None, "Unknown"
    year = int(m_year.group(0))

    yrs = _years_between(dt.date(year, month or 7, 1))
    return round(yrs, 2), ("Old" if yrs > TENURE_THRESHOLD_YEARS else "New")


DAY_TITLES = {
    1: "Day 1: Soil Health",
    2: "Day 2: Pest Management",
    3: "Day 3: Nutrition",
    4: "Day 4: Livestock Production",
    5: "Day 5: Climate Change Adaptation",
}

IDENTITY_COLS = {"Farmer_ID", "Farmer Name", "Organization", "County", "Sub.County", "Cluster",
                  "Workshop.Round", "Workshop.Content"}


def load_day_raw(day_num, n_questions_expected):
    df = pd.read_excel(RAW_FILE, sheet_name=f"Day{day_num}", header=0)
    round_col = df.columns[0]  # always the round column in every Day sheet
    df[round_col] = df[round_col].astype(str).str.strip().str.lower()
    df = df[df[round_col].isin(["baseline", "endline"])].copy()

    for col in ["Farmer Name", "Organization", "County"]:
        df[col] = df[col].astype(str).str.strip()

    # Question columns = the leading run of columns immediately after the
    # identity block (Assessment.Round/Workshop.Round/Workshop.Content/
    # Farmer_ID/Farmer Name/Organization/County/Sub.County/Cluster). Day 3-5
    # sheets also have a long tail of "diversity" item-list columns (crops,
    # trees, livestock feeds, etc.) after the real Q1..Qn questions, which
    # are NOT part of the practice-adoption question set, so we cut the
    # question list to the same length the old dashboard used per day.
    all_cols = list(df.columns)
    id_idx = max(all_cols.index(c) for c in ["Farmer_ID", "Farmer Name", "Organization",
                                              "County", "Sub.County", "Cluster"] if c in all_cols)
    question_cols = all_cols[id_idx + 1: id_idx + 1 + n_questions_expected]
    return df, round_col, question_cols


def old_dashboard_lookup():
    """Return (day,question)->(shortLabel, questionText) and
    (day,question,normalized_name)->reasonCategory from the previous
    dashboard_data.js, so labels/text/reasons carry over even though the
    raw workbook doesn't contain them."""
    try:
        with open(OLD_DASHBOARD_JS) as f:
            content = f.read()
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Could not find '{OLD_DASHBOARD_JS}' in the current folder. "
            "This script needs your existing dashboard_data.js (the one "
            "already sitting next to index.html) so it can carry over "
            "question labels, question text, and non-adoption reason "
            "strings that aren't present in the raw workbook. Run this "
            "script from the same folder as your dashboard_data.js and "
            "Endline_Data_Pilot.xlsx."
        )
    content = content.replace("const DASHBOARD_DATA = ", "", 1).rstrip().rstrip(";")
    old = json.loads(content)

    label_lookup = {}
    reason_lookup = {}
    for r in old["records"]:
        key = (r["day"], r["question"])
        if key not in label_lookup:
            label_lookup[key] = (r["shortLabel"], r["questionText"])
        if r.get("reasonCategory"):
            name_key = (r["day"], r["question"], r["farmerName"].strip().lower())
            reason_lookup[name_key] = r["reasonCategory"]
    return label_lookup, reason_lookup


def build_tenure_lookup():
    df = pd.read_excel(RAW_FILE, sheet_name="Endline_Qual.", header=0)
    lookup = {}
    for fid, group in df.groupby("Farmer_ID"):
        raw_val = None
        for v in group["Farmer_Membership"]:
            if v is not None and not (isinstance(v, float) and np.isnan(v)):
                raw_val = v
                break
        _, cat = classify_tenure(raw_val)
        lookup[fid] = cat
    return lookup


def build_day(day_num, label_lookup, reason_lookup, tenure_lookup, n_questions_expected):
    df, round_col, question_cols = load_day_raw(day_num, n_questions_expected)
    n_questions = len(question_cols)
    q_names = [f"Q{i+1}" for i in range(n_questions)]

    # Canonical Name/Organization/County per Farmer_ID: first non-null seen.
    canon = {}
    for fid, group in df.groupby("Farmer_ID"):
        canon[fid] = {
            "name": group["Farmer Name"].iloc[0],
            "org": group["Organization"].iloc[0],
            "county": group["County"].iloc[0],
        }

    baseline_ids = set(df.loc[df[round_col] == "baseline", "Farmer_ID"].dropna())
    endline_ids = set(df.loc[df[round_col] == "endline", "Farmer_ID"].dropna())
    n_baseline_surveyed = len(baseline_ids)
    n_endline_surveyed = len(endline_ids)
    n_not_found_endline = len(baseline_ids - endline_ids)

    # Wide -> long: one row per (Farmer_ID, round, question)
    melted = df.melt(
        id_vars=["Farmer_ID", round_col],
        value_vars=question_cols,
        var_name="raw_question_col",
        value_name="value",
    )
    col_to_q = dict(zip(question_cols, q_names))
    melted["Question"] = melted["raw_question_col"].map(col_to_q)
    melted["value"] = pd.to_numeric(melted["value"], errors="coerce")

    pivot = melted.pivot_table(
        index=["Farmer_ID", "Question"], columns=round_col, values="value", aggfunc="first"
    ).reset_index()
    if "baseline" not in pivot.columns:
        pivot["baseline"] = np.nan
    if "endline" not in pivot.columns:
        pivot["endline"] = np.nan

    # A farmer is "matched" for this day only if EVERY question has both
    # Baseline and Endline present (same complete-case rule as before).
    missing_either = pivot.loc[
        pivot["baseline"].isna() | pivot["endline"].isna(), "Farmer_ID"
    ].unique()
    matched_ids = baseline_ids & endline_ids - set(missing_either)
    n_matched = len(matched_ids)

    clean = pivot[pivot["Farmer_ID"].isin(matched_ids)].copy()

    records = []
    for _, r in clean.iterrows():
        fid = r["Farmer_ID"]
        q = r["Question"]
        name = canon[fid]["name"]
        short_label, question_text = label_lookup.get((day_num, q), (q, q))
        reason = reason_lookup.get((day_num, q, name.strip().lower()))
        records.append({
            "day": day_num,
            "question": q,
            "shortLabel": short_label,
            "questionText": question_text,
            "farmerName": name,
            "organization": canon[fid]["org"],
            "county": canon[fid]["county"],
            "tenure": tenure_lookup.get(fid, "Unknown"),
            "baseline": int(r["baseline"]),
            "endline": int(r["endline"]),
            "reasonCategory": reason if r["endline"] == 0 else None,
        })

    meta = {
        "day": day_num, "title": DAY_TITLES[day_num],
        "nBaselineSurveyed": n_baseline_surveyed,
        "nEndlineSurveyed": n_endline_surveyed,
        "nNotFoundEndline": n_not_found_endline,
        "nMatched": n_matched,
        "questions": q_names,
    }
    return records, meta, baseline_ids, endline_ids


if __name__ == "__main__":
    label_lookup, reason_lookup = old_dashboard_lookup()
    tenure_lookup = build_tenure_lookup()

    all_records = []
    day_meta = []
    global_baseline_ids = set()
    global_endline_ids = set()

    n_questions_by_day = {}
    for (day_num, q) in label_lookup:
        n_questions_by_day[day_num] = max(n_questions_by_day.get(day_num, 0), int(q[1:]))

    for day_num in [1, 2, 3, 4, 5]:
        records, meta, baseline_ids, endline_ids = build_day(
            day_num, label_lookup, reason_lookup, tenure_lookup,
            n_questions_by_day[day_num]
        )
        all_records.extend(records)
        day_meta.append(meta)
        global_baseline_ids |= baseline_ids
        global_endline_ids |= endline_ids
        print(f"Day {day_num}: baseline={meta['nBaselineSurveyed']} "
              f"endline={meta['nEndlineSurveyed']} "
              f"not-found-at-endline={meta['nNotFoundEndline']} "
              f"matched={meta['nMatched']} rows={len(records)}")

    n_unique_farmers_total = len(global_baseline_ids)
    n_unique_found_endline_any = len(global_baseline_ids & global_endline_ids)
    n_unique_not_found_endline_any = n_unique_farmers_total - n_unique_found_endline_any

    print(f"\nAcross all days combined (by Farmer_ID): "
          f"{n_unique_farmers_total} unique farmers at baseline, "
          f"{n_unique_found_endline_any} found at endline in at least one day, "
          f"{n_unique_not_found_endline_any} never found at endline in any day "
          f"they took part in.")

    reasons_carried = sum(1 for r in all_records if r["reasonCategory"])
    reasons_total_zero_endline = sum(1 for r in all_records if r["endline"] == 0)
    print(f"Reason categories carried over: {reasons_carried} of "
          f"{reasons_total_zero_endline} endline=0 rows "
          f"({reasons_carried/max(reasons_total_zero_endline,1)*100:.1f}%) "
          f"- the rest have no reasonCategory because the farmer name didn't "
          f"exactly match between the raw file and the old cleaned data.")

    payload = {
        "generatedNote": f"Data source: {DATA_SOURCE}",
        "overall": {
            "nUniqueFarmersTotal": n_unique_farmers_total,
            "nUniqueFoundEndlineAny": n_unique_found_endline_any,
            "nUniqueNotFoundEndlineAny": n_unique_not_found_endline_any,
        },
        "days": day_meta,
        "records": all_records,
    }

    with open(OUT_FILE, "w") as f:
        f.write("const DASHBOARD_DATA = ")
        json.dump(payload, f)
        f.write(";")

    print(f"\nWrote {OUT_FILE} with {len(all_records)} total rows across {len(day_meta)} days.")
