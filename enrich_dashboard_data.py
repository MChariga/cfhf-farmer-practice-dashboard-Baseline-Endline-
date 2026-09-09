"""
enrich_dashboard_data.py
=========================
IMPORTANT: this does NOT recompute baseline/endline adoption values, and it
does NOT touch reasonCategory. Those come from the already-cleaned
Individual_Responses / Individual_Transitions workbooks (via
build_dashboard_data.py + mel_common.py + practice_visuals.py) and are
treated as correct as-is.

Endline_Data_Pilot.xlsx (the raw, not-yet-cleaned workbook) is used ONLY
for three things, exactly as requested:
  1. The correct farmer list / true baseline & endline survey counts per
     day and overall (Farmer_ID is a reliable key; Name+Organization+County
     is not, because of spelling variants across sheets).
  2. Canonical Organization / County / Farmer Name per farmer, so the same
     person doesn't show up under two different spellings.
  3. Tenure, from Endline_Qual.'s Farmer_Membership column, looked up once
     per Farmer_ID and applied the same across every day.

Run this in the same folder as your existing dashboard_data.js and
Endline_Data_Pilot.xlsx:
    python3 enrich_dashboard_data.py
It overwrites dashboard_data.js in place (records' baseline/endline/
reasonCategory values are copied through unchanged).
"""

import json
import re
import difflib
import datetime as dt

import numpy as np
import pandas as pd

RAW_FILE = "Endline_Data_Pilot.xlsx"
DASHBOARD_JS = "dashboard_data.js"

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


def norm_name(s):
    s = str(s).strip().lower()
    s = re.sub(r"[^a-z\s]", "", s)
    return re.sub(r"\s+", " ", s).strip()


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


def build_day_identity_crosswalk(day_num):
    """name (normalized) -> {Farmer_ID, name, organization, county} for one day,
    plus the true baseline/endline Farmer_ID sets for that day."""
    df = pd.read_excel(RAW_FILE, sheet_name=f"Day{day_num}", header=0)
    round_col = df.columns[0]
    df[round_col] = df[round_col].astype(str).str.strip().str.lower()
    df = df[df[round_col].isin(["baseline", "endline"])].copy()
    for col in ["Farmer Name", "Organization", "County"]:
        df[col] = df[col].astype(str).str.strip()

    crosswalk = {}
    for fid, group in df.groupby("Farmer_ID"):
        name = group["Farmer Name"].iloc[0]
        crosswalk[norm_name(name)] = {
            "Farmer_ID": fid,
            "name": name,
            "organization": group["Organization"].iloc[0],
            "county": group["County"].iloc[0],
        }

    baseline_ids = set(df.loc[df[round_col] == "baseline", "Farmer_ID"].dropna())
    endline_ids = set(df.loc[df[round_col] == "endline", "Farmer_ID"].dropna())
    return crosswalk, baseline_ids, endline_ids


if __name__ == "__main__":
    try:
        with open(DASHBOARD_JS) as f:
            content = f.read()
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Could not find '{DASHBOARD_JS}' in the current folder. Run this "
            "script from the same folder as your existing dashboard_data.js "
            "and Endline_Data_Pilot.xlsx."
        )
    content_stripped = content.replace("const DASHBOARD_DATA = ", "", 1).rstrip().rstrip(";")
    data = json.loads(content_stripped)

    tenure_lookup = build_tenure_lookup()

    day_crosswalks = {}
    global_baseline_ids = set()
    global_endline_ids = set()
    for day_num in [1, 2, 3, 4, 5]:
        crosswalk, baseline_ids, endline_ids = build_day_identity_crosswalk(day_num)
        day_crosswalks[day_num] = crosswalk
        global_baseline_ids |= baseline_ids
        global_endline_ids |= endline_ids

    matched_exact = 0
    matched_fuzzy = 0
    unmatched_names = set()
    for r in data["records"]:
        crosswalk = day_crosswalks[r["day"]]
        key = norm_name(r["farmerName"])
        entry = crosswalk.get(key)
        if entry is None:
            # Fuzzy fallback: same day's farmer pool only (~210-220 candidates),
            # so a coincidental false match is unlikely; catches spelling drift
            # like "Lobert Lugazo" / "Robert Lungazo" between the two sources.
            candidates = difflib.get_close_matches(key, crosswalk.keys(), n=1, cutoff=0.82)
            if candidates:
                entry = crosswalk[candidates[0]]
                matched_fuzzy += 1
        else:
            matched_exact += 1
        if entry:
            r["organization"] = entry["organization"]
            r["county"] = entry["county"]
            r["tenure"] = tenure_lookup.get(entry["Farmer_ID"], r["tenure"])
        else:
            unmatched_names.add((r["day"], r["farmerName"]))

    total = len(data["records"])
    matched = matched_exact + matched_fuzzy
    print(f"Identity correction: matched {matched} of {total} record rows to the "
          f"raw farmer list ({matched_exact} exact name match, {matched_fuzzy} "
          f"fuzzy name match). {len(unmatched_names)} distinct (day, name) pairs "
          f"kept their original organization/county/tenure because no confident "
          f"match was found in the raw file for that day.")

    # Recompute per-day meta from the raw file (true survey counts), but keep
    # nMatched as the count of unique (corrected) farmers actually present in
    # this day's existing records - i.e. still driven by the already-cleaned
    # adoption data, not recomputed from raw.
    #
    # "Endline surveyed" per day uses the GLOBAL found-at-endline set (any
    # day), not just that day's own endline rows: a farmer who genuinely had
    # an endline visit had all of that visit's data captured, so if their
    # Day-N endline row is missing/blank but they show up as endline-found
    # on another day, they still count as found for Day N too (as long as
    # they were part of Day N's baseline). Only true baseline attendance
    # varies by day; being "found at endline" is a property of the farmer,
    # not of the day.
    def farmer_key(r):
        return f"{r['farmerName'].strip().lower()}|{r['organization'].strip().lower()}|{r['county'].strip().lower()}"

    for meta in data["days"]:
        day_num = meta["day"]
        _, baseline_ids, _ = build_day_identity_crosswalk(day_num)
        day_records = [r for r in data["records"] if r["day"] == day_num]
        n_matched_now = len({farmer_key(r) for r in day_records})
        found_this_day = baseline_ids & global_endline_ids
        meta["nBaselineSurveyed"] = len(baseline_ids)
        meta["nEndlineSurveyed"] = len(found_this_day)
        meta["nNotFoundEndline"] = len(baseline_ids - global_endline_ids)
        meta["nMatched"] = n_matched_now

    data["overall"] = {
        "nUniqueFarmersTotal": len(global_baseline_ids),
        "nUniqueFoundEndlineAny": len(global_baseline_ids & global_endline_ids),
        "nUniqueNotFoundEndlineAny": len(global_baseline_ids - global_endline_ids),
    }

    with open(DASHBOARD_JS, "w") as f:
        f.write("const DASHBOARD_DATA = ")
        json.dump(data, f)
        f.write(";")

    print("Overall (true, from raw file):", data["overall"])
    for meta in data["days"]:
        print(meta["day"], meta["title"], "baseline=", meta["nBaselineSurveyed"],
              "endline=", meta["nEndlineSurveyed"], "notFound=", meta["nNotFoundEndline"],
              "matched(in existing adoption data)=", meta["nMatched"])
    print(f"\nWrote {DASHBOARD_JS} - baseline/endline/reasonCategory values unchanged; "
          "only organization/county/tenure and the survey-count KPIs were corrected.")
