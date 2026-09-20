"""
build_dashboard_data.py
========================
Builds dashboard_data.js from TWO kinds of source file, each used for what
it's reliably good at:

  1. Endline_Data_Pilot.xlsx (the raw, not-yet-cleaned workbook) is used
     ONLY to reconcile farmer identity and baseline/endline/not-found
     counts. Its Farmer_ID is a reliable key (unlike Name+Organization+
     County, which silently splits a real farmer into two when their name
     is spelled two different ways across sheets).

  2. Day_one.xlsx / Day_Two.xlsx / Day_Three.xlsx / Day_Four.xlsx /
     Day_Five.xlsx (the already-cleaned, per-day analysis workbooks) are
     used for every question-level value in the graphs: baseline/endline
     answers and non-adoption reason categories. These went through a
     careful farmer-by-farmer, question-by-question review (see each
     workbook's own README sheet) that the raw file does not capture -
     reconstructing reasonCategory via a fuzzy (day, question, name)
     lookup against an old dashboard export, as an earlier version of this
     script did, only recovered about 60% of rows. Reading it straight
     from these workbooks recovers 100%.

Because the cleaned Day_N workbooks don't carry Farmer_ID (only a "Farmer
Name" column, sometimes truncated, reordered, or a combined multi-person
entry), every row is matched back to the raw file's Farmer_ID via a tiered
name-matching pass (see match_farmer()) so its organization/county/tenure
come from the same canonical source as the identity counts.

Three things this script deliberately guarantees, per a reconciliation
request in this project:

  - nBaselineSurveyed == nEndlineSurveyed + nNotFoundEndline, ALWAYS, for
    every day. All three are computed from the SAME per-day baseline/
    endline Farmer_ID sets (baseline, baseline & endline, baseline -
    endline) - a disjoint split, not three separately-sourced numbers - so
    they can never fail to add up.

  - A farmer is only dropped from a day's charts entirely if they have NO
    valid (baseline-and-endline-present) rows anywhere in that day's
    cleaned workbook. If they're missing just one question, only that
    (farmer, question) row is skipped - every other question they answered
    at both rounds still counts.

  - Farmer identity (name/organization/county/tenure) always comes from
    the raw file's Farmer_ID, never from the cleaned workbook's own
    Organization/County/Farmer_Membership text, so it stays consistent
    with the KPI cards' identity/tenure filters.
"""

import json
import re
import io
import difflib
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
    """Unchanged from prior versions of this script."""
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


def build_tenure_lookup():
    df = pd.read_excel(RAW_FILE, sheet_name="Endline_Qual.", header=0)
    df["Farmer_ID"] = _merge_farmer_ids(df["Farmer_ID"])
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


DAY_TITLES = {
    1: "Day 1: Soil Health",
    2: "Day 2: Pest Management",
    3: "Day 3: Nutrition",
    4: "Day 4: Livestock Production",
    5: "Day 5: Climate Change Adaptation",
}

# Which cleaned workbook + sheet holds Day N's per-farmer, per-question data,
# and which of that sheet's columns map to our common schema. Day 1's sheet
# and column names differ slightly from Days 2-5 (an earlier "Type 1"
# analysis vs later "Type 2" ones), and Days 3-4 lack Question_Text/County/
# Farmer_Membership columns entirely - all handled here rather than assuming
# one layout.
DAY_FILES = {
    1: "Day_one.xlsx",
    2: "Day_Two.xlsx",
    3: "Day_Three.xlsx",
    4: "Day_Four.xlsx",
    5: "Day_Five.xlsx",
}
DAY_SHEET = {
    1: "Individual_Responses",
    2: "Individual_Transitions",
    3: "Individual_Transitions",
    4: "Individual_Transitions",
    5: "Individual_Transitions",
}
DAY_COLUMNS = {
    1: {"question": "Question", "farmer": "Farmer Name", "baseline": "Baseline", "endline": "Endline", "reason": "Category", "question_text": "Question_Text", "narrative": "Narrative"},
    2: {"question": "Question", "farmer": "Farmer Name", "baseline": "Baseline", "endline": "Endline", "reason": "Reason_Category", "question_text": "Question_Text", "narrative": "Narrative"},
    3: {"question": "Question", "farmer": "Farmer Name", "baseline": "Baseline", "endline": "Endline", "reason": "Reason_Category", "question_text": "Question_Text", "narrative": "Narrative"},
    4: {"question": "Question", "farmer": "Farmer Name", "baseline": "Baseline", "endline": "Endline", "reason": "Reason_Category", "question_text": "Question_Text", "narrative": "Narrative"},
    5: {"question": "Question", "farmer": "Farmer Name", "baseline": "Baseline", "endline": "Endline", "reason": "Reason_Category", "question_text": "Question_Text", "narrative": "Narrative"},
}

# A handful of names in the cleaned workbooks refer to a combined multi-
# person or otherwise irregular entry, where the correct individual match
# is documented (Day 1's README) rather than inferable from the string
# itself - splitting-and-taking-the-first-listed-name would pick the WRONG
# person for the 5-person group entry below, so these are hardcoded rather
# than left to the generic tiers. Keyed by the exact (lowercased, stripped)
# name as it appears in the cleaned workbooks.
NAME_ALIASES = {
    "steve omollo/ zephania ojiem": "steve omollo",
    "gaudencia teyia": "gaudencia nora teiye",
}

# Names that must NEVER be attributed to anyone - not via alias, and not via
# any of match_farmer()'s generic tiers either. The 5-person combined group
# entry below is exactly this case: Day 1's README says to use it for
# Cynthia's BASELINE record, but it also carries an Endline value that isn't
# verified as hers (see NAME_ALIASES history), so we stopped aliasing it to
# her - but doing only that let the generic "split on comma, try the first
# name" tier catch it instead and misattribute the whole row to "Caroline A
# Ochieng" (the first name listed), creating duplicate/contradictory rows
# for her. Excluding it here means the row is dropped entirely, for
# everyone, on every day it appears - the correct behavior for data that
# can't be confidently attributed to one individual.
EXCLUDED_NAMES = {
    "caroline a ochieng,biron corazon otieno,cynthia a odhiambo,yvonne odhiambo ,washington gavine ajowi",
}

# The raw pilot file recorded the SAME real person under two different
# Farmer_IDs in Day 5 - one used only for her baseline round, a different
# one used only for her endline round (a genuine raw data-entry
# inconsistency, not a name-matching artifact: the cleaned Day_Five.xlsx
# workbook already treats her as one continuous farmer, "Jackline Adeng'
# Akinyi"). Merge the baseline-only ID into the endline-only one so every
# lookup (identity, baseline/endline sets, tenure) treats them as one
# farmer. Old ID -> canonical ID kept.
FARMER_ID_MERGES = {
    45555: 80216,  # "Jackline Akinyi" (baseline only) -> "Jackline Ondeg" (endline only)
}
# Canonical display name for a merged identity, keyed by the ID kept above.
FARMER_ID_MERGE_NAMES = {
    80216: "Jackline Ondeg",
}


def _merge_farmer_ids(series):
    """Coerce to numeric and fold any merged (duplicate-identity) Farmer_IDs
    into their canonical ID, regardless of int/float dtype quirks."""
    s = pd.to_numeric(series, errors="coerce")
    merge_map = {}
    for old, new in FARMER_ID_MERGES.items():
        merge_map[old] = new
        merge_map[float(old)] = float(new)
    return s.replace(merge_map)


def norm_name(s):
    s = str(s).strip().lower()
    s = re.sub(r"[^a-z\s]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _tokens(s):
    return norm_name(s).split()


def _fuzzy_token_subset(day_toks, cand_toks, cutoff=0.8):
    """True if every token in day_toks has a close counterpart (typo-level
    edit distance) somewhere in cand_toks. Catches spelling drift like
    'Lobert Lugazo' vs 'Robert Lungazo' or 'Hildah Aggay' vs 'Hilda Atieno
    Aggay' that a whole-string similarity ratio misses once a name is also
    missing a word."""
    for dt_ in day_toks:
        if not any(difflib.SequenceMatcher(None, dt_, ct).ratio() >= cutoff for ct in cand_toks):
            return False
    return True


def _try_exact_or_subset(key, crosswalk):
    if key in crosswalk:
        return crosswalk[key], "exact"
    day_toks = set(key.split())
    if day_toks:
        hits = [e for k, e in crosswalk.items() if day_toks.issubset(set(k.split()))]
        if len(hits) == 1:
            return hits[0], "subset"
    return None, None


def match_farmer(name, crosswalk):
    """Match a cleaned-workbook 'Farmer Name' string to the raw file's
    farmer identity for this day. crosswalk: normalized-name -> entry
    (Farmer_ID/name/organization/county). Tries, in order: a documented
    alias; an exact or token-subset match (handles a dropped middle/last
    name); the first part of a combined "A/B" or "A,B,C" entry; a per-token
    fuzzy match (handles spelling drift); a whole-string fuzzy match; and a
    sorted-token fuzzy match (handles two names given in a different
    order). Returns (entry, tier) or (None, None)."""
    raw_key = str(name).strip().lower()
    if raw_key in EXCLUDED_NAMES:
        return None, None
    if raw_key in NAME_ALIASES:
        alias_key = norm_name(NAME_ALIASES[raw_key])
        if alias_key in crosswalk:
            return crosswalk[alias_key], "alias"

    key = norm_name(name)
    entry, tier = _try_exact_or_subset(key, crosswalk)
    if entry:
        return entry, tier

    for sep in ["/", ","]:
        if sep in str(name):
            first_part = str(name).split(sep)[0].strip()
            entry, tier = _try_exact_or_subset(norm_name(first_part), crosswalk)
            if entry:
                return entry, "split"

    day_toks = _tokens(name)
    if day_toks:
        hits = [e for k, e in crosswalk.items() if _fuzzy_token_subset(day_toks, k.split())]
        if len(hits) == 1:
            return hits[0], "fuzzy-token"

    cand = difflib.get_close_matches(key, crosswalk.keys(), n=1, cutoff=0.82)
    if cand:
        return crosswalk[cand[0]], "fuzzy"

    skey = " ".join(sorted(day_toks))
    sorted_index = {}
    for k, e in crosswalk.items():
        sorted_index.setdefault(" ".join(sorted(k.split())), []).append(e)
    cand2 = difflib.get_close_matches(skey, sorted_index.keys(), n=1, cutoff=0.82)
    if cand2 and len(sorted_index[cand2[0]]) == 1:
        return sorted_index[cand2[0]][0], "sorted-fuzzy"

    return None, None


def to_binary(val):
    """0/1 if val cleanly encodes a yes/no response, else None (missing -
    covers real NaN as well as the sentinel strings each day's cleaned
    workbook uses for a gap: 'Null' in Day 1, 'N/A1' in Day 5, etc.)."""
    if val is None:
        return None
    if isinstance(val, float) and np.isnan(val):
        return None
    if isinstance(val, (int, float)):
        if val == 0:
            return 0
        if val == 1:
            return 1
        return None
    s = str(val).strip().lower()
    if s in ("0", "0.0"):
        return 0
    if s in ("1", "1.0"):
        return 1
    return None


def find_header_row(path, sheet, marker="Question", scan_rows=8):
    raw = pd.read_excel(path, sheet_name=sheet, header=None, nrows=scan_rows)
    for i in range(len(raw)):
        if raw.iloc[i].astype(str).str.strip().eq(marker).any():
            return i
    raise ValueError(f"Could not find a header row containing '{marker}' in {path}::{sheet}")


def build_day_crosswalk(day_num):
    """norm_name -> {Farmer_ID, name, organization, county} for this day,
    plus the day's TRUE baseline/endline Farmer_ID sets, straight from the
    raw workbook. This is the single source of truth for identity and for
    the baseline/endline/not-found KPI counts."""
    df = pd.read_excel(RAW_FILE, sheet_name=f"Day{day_num}", header=0)
    round_col = df.columns[0]
    df[round_col] = df[round_col].astype(str).str.strip().str.lower()
    df = df[df[round_col].isin(["baseline", "endline"])].copy()
    for col in ["Farmer Name", "Organization", "County"]:
        df[col] = df[col].astype(str).str.strip()
    df["Farmer_ID"] = _merge_farmer_ids(df["Farmer_ID"])

    crosswalk = {}
    for fid, group in df.groupby("Farmer_ID"):
        name = FARMER_ID_MERGE_NAMES.get(fid, group["Farmer Name"].iloc[0])
        entry = {
            "Farmer_ID": fid,
            "name": name,
            "organization": group["Organization"].iloc[0],
            "county": group["County"].iloc[0],
        }
        crosswalk[norm_name(name)] = entry
        # Also index every OTHER spelling this farmer appears under in the
        # raw file (relevant for merged identities, which by definition
        # have at least two) so a cleaned-workbook row using either name
        # still resolves to the same merged entry.
        for alt in group["Farmer Name"].unique():
            crosswalk.setdefault(norm_name(alt), entry)

    baseline_ids = set(df.loc[df[round_col] == "baseline", "Farmer_ID"].dropna())
    endline_ids = set(df.loc[df[round_col] == "endline", "Farmer_ID"].dropna())
    return crosswalk, baseline_ids, endline_ids


def old_dashboard_lookup():
    """Return (day,question)->(shortLabel, questionText) from the previous
    dashboard_data.js, so question labels/text carry over even though the
    cleaned workbooks don't all include a Question_Text column. (Unlike an
    earlier version of this script, reasonCategory is NOT sourced this way
    any more - it now comes directly from each day's own cleaned workbook,
    which is far more complete.)"""
    try:
        with open(OLD_DASHBOARD_JS) as f:
            content = f.read()
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Could not find '{OLD_DASHBOARD_JS}' in the current folder. "
            "This script needs your existing dashboard_data.js (the one "
            "already sitting next to index.html) so it can carry over "
            "question labels and question text. Run this script from the "
            "same folder as your dashboard_data.js, Endline_Data_Pilot.xlsx "
            "and the five Day_*.xlsx workbooks."
        )
    content = content.replace("const DASHBOARD_DATA = ", "", 1).rstrip().rstrip(";")
    old = json.loads(content)

    label_lookup = {}
    for r in old["records"]:
        key = (r["day"], r["question"])
        if key not in label_lookup:
            label_lookup[key] = (r["shortLabel"], r["questionText"])
    return label_lookup


def build_day(day_num, label_lookup, tenure_lookup):
    crosswalk, baseline_ids, endline_ids = build_day_crosswalk(day_num)
    canon = {entry["Farmer_ID"]: entry for entry in crosswalk.values()}

    path = DAY_FILES[day_num]
    sheet = DAY_SHEET[day_num]
    hdr = find_header_row(path, sheet)
    df = pd.read_excel(path, sheet_name=sheet, header=hdr)
    df.columns = [str(c).strip() for c in df.columns]
    cols = dict(DAY_COLUMNS[day_num])

    # Guard against the exact schema drift that broke Day 1 previously: if
    # the configured endline/reason column name isn't actually in this
    # workbook, fall back to whichever of the known alternate names is
    # present, instead of silently returning zero rows.
    if cols["endline"] not in df.columns:
        for alt in ("Endline", "Endline_Code"):
            if alt in df.columns:
                cols["endline"] = alt
                break
    if cols["reason"] not in df.columns:
        for alt in ("Category", "Reason_Category"):
            if alt in df.columns:
                cols["reason"] = alt
                break

    # Some workbooks include their own Question_Text column. We still prefer
    # the OLD dashboard's label_lookup first (it carries the manually-
    # curated short label style, e.g. "Leave.Crop.Residue", that a raw
    # Question_Text sentence doesn't match) - this is only a fallback for a
    # question that label_lookup has never seen before (newly added,
    # renumbered, etc.), so it reads as an actual question instead of a
    # bare code like "Q9".
    text_col = cols.get("question_text")
    sheet_text_lookup = {}
    if text_col and text_col in df.columns:
        for _, r in df[[cols["question"], text_col]].dropna().iterrows():
            qq = str(r[cols["question"]]).strip()
            if qq and qq not in sheet_text_lookup:
                txt = str(r[text_col]).strip()
                if txt:
                    sheet_text_lookup[qq] = txt

    match_tiers = {}
    unmatched_names = set()
    matched_fids = set()
    records = []

    for _, row in df.iterrows():
        q = row.get(cols["question"])
        if pd.isna(q) or str(q).strip() == "":
            continue
        q = str(q).strip()

        name_raw = row.get(cols["farmer"])
        if pd.isna(name_raw) or str(name_raw).strip() == "":
            continue

        # Concern: a farmer should only be dropped from a day's charts
        # entirely if EVERY question is missing for them. Here we simply
        # skip THIS (farmer, question) row when either round is missing -
        # every other question row for the same farmer is untouched.
        base = to_binary(row.get(cols["baseline"]))
        end = to_binary(row.get(cols["endline"]))
        if base is None or end is None:
            continue

        entry, tier = match_farmer(name_raw, crosswalk)
        if entry is None:
            unmatched_names.add(str(name_raw).strip())
            continue
        match_tiers[tier] = match_tiers.get(tier, 0) + 1

        fid = entry["Farmer_ID"]
        matched_fids.add(fid)

        reason_val = row.get(cols["reason"])
        reason = None
        if end == 0 and reason_val is not None and not (isinstance(reason_val, float) and np.isnan(reason_val)):
            reason_str = str(reason_val).strip()
            if reason_str and reason_str.lower() not in ("nan", "none"):
                reason = reason_str

        # Narrative is a free-text field the enumerator wrote for this
        # farmer/question, independent of the coded Reason_Category theme -
        # captured for every row (not just non-adopters) so the
        # Farmer-Level Detail table can show it regardless of baseline/
        # endline status.
        narrative = None
        narrative_col = cols.get("narrative")
        if narrative_col:
            narrative_val = row.get(narrative_col)
            if narrative_val is not None and not (isinstance(narrative_val, float) and np.isnan(narrative_val)):
                narrative_str = str(narrative_val).strip()
                if narrative_str and narrative_str.lower() not in ("nan", "none"):
                    narrative = narrative_str

        short_label, question_text = label_lookup.get((day_num, q), (None, None))
        if question_text is None:
            # Not in the OLD dashboard's history (new/renumbered question) -
            # use the workbook's own Question_Text if we found one for this
            # code, otherwise fall back to the bare code as a last resort.
            fallback_text = sheet_text_lookup.get(q, q)
            short_label = fallback_text
            question_text = fallback_text
        records.append({
            "day": day_num,
            "question": q,
            "shortLabel": short_label,
            "questionText": question_text,
            "farmerName": entry["name"],
            "organization": entry["organization"],
            "county": entry["county"],
            "tenure": tenure_lookup.get(fid, "Unknown"),
            "baseline": base,
            "endline": end,
            "reasonCategory": reason,
            "narrative": narrative,
        })

    if unmatched_names:
        print(f"  Day {day_num}: {len(unmatched_names)} farmer name(s) in {DAY_FILES[day_num]} "
              f"could not be matched to the raw file's Day {day_num} farmer list "
              f"(dropped from this day's charts only - identity/KPI counts are "
              f"unaffected): {sorted(unmatched_names)}")

    # These three are computed from the SAME disjoint split of baseline_ids,
    # so nBaselineSurveyed == nEndlineSurveyed + nNotFoundEndline always.
    n_baseline_surveyed = len(baseline_ids)
    n_endline_surveyed = len(baseline_ids & endline_ids)
    n_not_found_endline = len(baseline_ids - endline_ids)
    n_matched = len(matched_fids)

    all_fids_this_day = baseline_ids | endline_ids
    farmers = []
    for fid in all_fids_this_day:
        c = canon.get(fid)
        if c is None:
            continue
        farmers.append({
            "farmerId": int(fid),
            "farmerName": c["name"],
            "organization": c["organization"],
            "county": c["county"],
            "tenure": tenure_lookup.get(fid, "Unknown"),
            "atBaseline": fid in baseline_ids,
            "atEndlineThisDay": fid in endline_ids,
            "foundAtEndlineAnyDay": None,  # filled in once every day is processed
            "matched": fid in matched_fids,
        })
    farmers.sort(key=lambda x: x["farmerName"].lower())

    meta = {
        "day": day_num, "title": DAY_TITLES[day_num],
        "nBaselineSurveyed": n_baseline_surveyed,
        "nEndlineSurveyed": n_endline_surveyed,
        "nNotFoundEndline": n_not_found_endline,
        "nMatched": n_matched,
        "questions": sorted({r["question"] for r in records}, key=lambda x: int(re.sub(r"\D", "", x) or 0)),
        "farmers": farmers,
    }
    print(f"Day {day_num}: baseline={n_baseline_surveyed} endline={n_endline_surveyed} "
          f"not-found={n_not_found_endline} matched={n_matched} rows={len(records)} "
          f"(name match tiers: {match_tiers})")
    return records, meta, baseline_ids, endline_ids


if __name__ == "__main__":
    label_lookup = old_dashboard_lookup()
    tenure_lookup = build_tenure_lookup()

    all_records = []
    day_meta = []
    global_baseline_ids = set()
    global_endline_ids = set()

    for day_num in [1, 2, 3, 4, 5]:
        records, meta, baseline_ids, endline_ids = build_day(day_num, label_lookup, tenure_lookup)
        all_records.extend(records)
        day_meta.append(meta)
        global_baseline_ids |= baseline_ids
        global_endline_ids |= endline_ids

    # foundAtEndlineAnyDay needs the GLOBAL endline set (found on ANY day),
    # which is only known once every day has been processed.
    for meta in day_meta:
        for farmer in meta["farmers"]:
            farmer["foundAtEndlineAnyDay"] = farmer["farmerId"] in global_endline_ids

    n_unique_farmers_total = len(global_baseline_ids)
    n_unique_found_endline_any = len(global_baseline_ids & global_endline_ids)
    n_unique_not_found_endline_any = n_unique_farmers_total - n_unique_found_endline_any

    print(f"\nAcross all days combined (by Farmer_ID): "
          f"{n_unique_farmers_total} unique farmers at baseline, "
          f"{n_unique_found_endline_any} found at endline in at least one day, "
          f"{n_unique_not_found_endline_any} never found at endline in any day "
          f"they took part in.")

    # --- Overview-page per-day summary override -----------------------------
    # The Overview tab's per-day summary and "Matched Sample Size by Day"
    # chart read nBaselineSurveyed/nEndlineSurveyed straight from each day's
    # meta object. Left alone, nEndlineSurveyed is a day-specific count
    # (baseline attendees also endline-found THAT day), which varies day to
    # day by a farmer or two even when the underlying data has no real gaps.
    # Per project decision, the Overview page instead shows "Farmers at
    # Endline" as the single GLOBAL found-at-endline total for every day
    # (141 as of this dataset) - since endline was one comprehensive visit,
    # not a day-specific one - with nBaselineSurveyed DERIVED from it
    # (global endline + that day's real not-found count) rather than
    # hardcoded, so the baseline/endline/not-found identity always holds
    # automatically and never needs manual re-editing again, even as
    # upstream fixes (like the Cynthia/Jackline correction) shift the true
    # not-found counts. This override affects ONLY the Overview page - the
    # per-day tab KPI cards and every chart still read the real, farmer-
    # level, per-day data untouched.
    for meta in day_meta:
        meta["nEndlineSurveyed"] = n_unique_found_endline_any
        meta["nBaselineSurveyed"] = n_unique_found_endline_any + meta["nNotFoundEndline"]

    # Sanity check for the "baseline == endline + not-found" guarantee -
    # this should never print anything, but fail loudly if it ever would.
    for meta in day_meta:
        if meta["nBaselineSurveyed"] != meta["nEndlineSurveyed"] + meta["nNotFoundEndline"]:
            raise AssertionError(f"Day {meta['day']}: baseline/endline/not-found do not add up - "
                                  f"{meta['nBaselineSurveyed']} != {meta['nEndlineSurveyed']} + {meta['nNotFoundEndline']}")

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
