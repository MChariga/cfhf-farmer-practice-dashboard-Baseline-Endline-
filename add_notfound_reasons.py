"""
add_notfound_reasons.py
========================
Adds a "reasonNotAssessed" field to every farmer entry in dashboard_data.js's
per-day `farmers` list, sourced from Endline_Data_Pilot.xlsx's
MissingFarmers sheet (columns: Farmer ID, Farmer Name, Workshop Round,
Organization, County, Sub County, Cluster, Farmer Assessed,
Reason Not Assessed).

IMPORTANT - matching key: Farmer ID only, ignoring "Workshop Round".
MissingFarmers has exactly one row per farmer for the whole study (no
duplicate Farmer IDs), and a farmer's "Workshop Round" there does NOT
correspond to the Day1-Day5 sheet(s)/dashboard days that farmer shows up
as a baseline attendee in (a farmer can attend several training days but
has a single overall endline-assessment status/reason). Matching by
(Farmer ID, day) as an earlier version of this script did left ~80% of
not-found farmers unmatched purely because of that round/day mismatch -
matching by Farmer ID alone gives 100% coverage of the not-found
population against MissingFarmers.

For every day's `farmers` list, for each farmer with atBaseline=true and
atEndlineThisDay=false, this looks up that Farmer ID in MissingFarmers:
  - "Farmer Assessed" == "No"  -> reasonNotAssessed = "Reason Not Assessed"
  - "Farmer Assessed" == "Yes" -> left blank (MissingFarmers says they WERE
    assessed, which conflicts with the day-level "not found" flag - a small
    number of farmers fall in this bucket; there's no "why" to report for
    them since the tracking sheet doesn't say they were missed).
  - not present at all         -> left blank (shouldn't happen given the
    checks above, but kept as a safe default).

Run this in the same folder as dashboard_data.js and
Endline_Data_Pilot.xlsx:
    python3 add_notfound_reasons.py
It overwrites dashboard_data.js in place.
"""

import json

import pandas as pd

RAW_FILE = "Endline_Data_Pilot.xlsx"
DASHBOARD_JS = "dashboard_data.js"


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

    mf = pd.read_excel(RAW_FILE, sheet_name="MissingFarmers")
    mf["Farmer ID"] = mf["Farmer ID"].astype(int)

    reason_by_id = {}
    assessed_yes_ids = set()
    for _, row in mf.iterrows():
        fid = int(row["Farmer ID"])
        if row["Farmer Assessed"] == "No":
            reason = row["Reason Not Assessed"]
            reason = None if (reason is None or (isinstance(reason, float) and pd.isna(reason))) else str(reason).strip()
            reason_by_id[fid] = reason
        elif row["Farmer Assessed"] == "Yes":
            assessed_yes_ids.add(fid)

    total_not_found = 0
    total_matched = 0
    total_conflict = 0  # flagged not-found by the dashboard, but MissingFarmers says "Yes"
    total_untracked = 0  # not in MissingFarmers at all

    for meta in data["days"]:
        farmers = meta["farmers"]
        for p in farmers:
            p["reasonNotAssessed"] = None

        not_found = [p for p in farmers if p["atBaseline"] and not p["atEndlineThisDay"]]
        total_not_found += len(not_found)
        for p in not_found:
            fid = p["farmerId"]
            if fid in reason_by_id:
                p["reasonNotAssessed"] = reason_by_id[fid]
                total_matched += 1
            elif fid in assessed_yes_ids:
                total_conflict += 1
            else:
                total_untracked += 1

    with open(DASHBOARD_JS, "w") as f:
        f.write("const DASHBOARD_DATA = ")
        json.dump(data, f)
        f.write(";")

    print(
        f"Reason-not-assessed match: {total_matched} of {total_not_found} "
        f"not-found-at-endline farmer-day rows matched to a MissingFarmers "
        f"'No' row by Farmer ID. {total_conflict} were flagged not-found by "
        f"the dashboard but marked 'Yes' (assessed) in MissingFarmers - left "
        f"blank since there's no reason recorded for those. {total_untracked} "
        f"were not in MissingFarmers at all."
    )
    print(f"Wrote {DASHBOARD_JS} - added 'reasonNotAssessed' to every farmer entry.")
