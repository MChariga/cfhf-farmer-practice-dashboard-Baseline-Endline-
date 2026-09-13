# CFHF Farmer Practice Adoption Dashboard

This project turns farmer training survey data (baseline and endline, across 5 training days) into an interactive web dashboard your team can browse and filter. It also includes optional scripts for generating static PNG charts.

Data source: Kenya AE Hub, CFHF Project Evaluation Data, 2025/26.

## What each file does

**Data pipeline (run these in order, in the same folder):**

- `Day_one.xlsx`, `Day_Two.xlsx`, `Day_Three.xlsx`, `Day_Four.xlsx`, `Day_Five.xlsx`
  The cleaned, per-day source workbooks. Each has an `Individual_Responses` or `Individual_Transitions` sheet with one row per farmer per practice question, already matched into baseline/endline pairs. These are the source of truth for all adoption percentages and charts.

- `mel_common.py`
  Shared cleaning and charting logic used by `build_dashboard_data.py` for Days 2 to 5 (loading, pairing baseline/endline, summarizing, and the static chart functions).

- `practice_visuals.py`
  The same kind of logic as `mel_common.py`, but specific to Day 1's workbook layout.

- `build_dashboard_data.py`
  Reads all five day workbooks through `mel_common.py` and `practice_visuals.py`, and writes `dashboard_data.js`. This is the only script that should ever set the baseline/endline adoption values. Run it whenever a `Day_*.xlsx` file changes.

  Important: there was a version of this file that reconstructed adoption data straight from `Endline_Data_Pilot.xlsx` instead. Do not use that version. The correct `build_dashboard_data.py` imports `mel_common` and `practice_visuals` at the top. If your copy does not, replace it.

- `Endline_Data_Pilot.xlsx`
  The true original, uncleaned survey data (one row per farmer per day per round, plus an `Endline_Qual.` sheet with membership/tenure info). This file is used only to correct farmer identity information. It is never used to compute adoption percentages, because it has not been cleaned or matched the way the `Day_*.xlsx` workbooks have.

- `enrich_dashboard_data.py`
  Runs after `build_dashboard_data.py`. Opens `dashboard_data.js`, and using `Endline_Data_Pilot.xlsx` as a reference, corrects three things per farmer: Organization, County, and Tenure (New or Old, based on `Endline_Qual.`'s membership notes). It also recalculates the true baseline and endline survey counts shown in the Overview tab. It does not change any `baseline`, `endline`, or `reasonCategory` value. Run this every time `Endline_Data_Pilot.xlsx` is updated, even if the day workbooks have not changed.

- `dashboard_data.js`
  The final output data file, loaded by the dashboard. This is a plain JavaScript file containing one `DASHBOARD_DATA` object with all farmer records and per-day summary numbers.

**Dashboard (the part your team opens in a browser):**

- `index.html`
  The page shell: header, navigation tabs, styling, and the script tags that load `dashboard_data.js` and `app.js`.

- `app.js`
  All of the dashboard's logic: building each day's view, the filters (Organization, County, Tenure, Farmer name, Practice), the KPI cards, the charts, the farmer transition (alluvial) diagram, the data table, and the password-gated download panel on the Overview tab.

**Optional standalone chart scripts (not part of the web dashboard):**

- `Additional_visual.py`
  A standalone script that reads a single day workbook directly and saves five PNG charts to disk (stacked bar, dumbbell chart, diverging change chart, and two reason-for-non-adoption charts). Useful for slides or a written report, separate from the interactive dashboard.

## How to update the dashboard with new data

1. If any `Day_*.xlsx` workbook changed, run:
   ```
   python3 build_dashboard_data.py
   ```
   This regenerates `dashboard_data.js` from scratch, using only the cleaned day workbooks.

2. Then, always run:
   ```
   python3 enrich_dashboard_data.py
   ```
   This patches farmer identity (Organization, County, Tenure) and the survey count KPIs using `Endline_Data_Pilot.xlsx`, without touching any adoption value.

3. Open `index.html` in a browser (or redeploy it, see below) to see the update.

If you only update `Endline_Data_Pilot.xlsx` (for example, a corrected county or tenure note) and none of the day workbooks changed, you can skip step 1 and just run step 2 again.

Do not run `build_dashboard_data.py` after `enrich_dashboard_data.py` without re-running `enrich_dashboard_data.py` again afterward, since step 1 will overwrite the corrections from step 2.

## Requirements

Python packages needed for the data pipeline:
```
pip install pandas numpy openpyxl matplotlib
```
No build step or server is needed for the dashboard itself. `index.html`, `app.js`, and `dashboard_data.js` are static files that can be opened directly or hosted on any static file host (GitHub Pages, Netlify, etc.).

## Downloading data from the dashboard

The Overview tab has a "Download Data" panel that is password protected. Entering the password unlocks buttons to download all farmer-practice records, a one-row-per-farmer summary, each day's data individually, and the full dataset as JSON. This is a basic client-side check, not real security. It keeps casual visitors from pulling the underlying data, but is not a substitute for restricting who can reach the page at all if the data is sensitive.

## Known limitations

- Non-adoption reason text (`reasonCategory`) only exists in the cleaned day workbooks, not in `Endline_Data_Pilot.xlsx`. If a farmer's name does not match closely enough between the two sources, their reason text may be missing even where they answered "not doing" a practice.
- Farmer identity matching between `Endline_Data_Pilot.xlsx` and the day workbooks is done by name, since the day workbooks do not carry a Farmer ID field. Matching is exact first, then a close-match fallback. A small number of farmers may not match and will keep whatever Organization, County, or Tenure value the day workbook already had for them.
