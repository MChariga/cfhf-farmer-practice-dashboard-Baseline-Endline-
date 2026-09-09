"""
Day 4 Livestock Production Practices - Practice Adoption Visuals
==================================================================
Same charts and cleaning rules as Day 1's practice_visuals.py, pointed at
the Day_Four.xlsx workbook. All shared logic lives in mel_common.py so every
day stays visually and methodologically identical - only the config below
changes.

Run with:
    python3 day4_practice_visuals.py
"""

from mel_common import (
    load_data, clean_pairs, summarize, reason_breakdown_not_doing,
    chart_stacked, chart_dumbbell, chart_diverging,
    chart_top_reasons_overall, chart_reason_mix_weak,
)

# ---------------------------------------------------------------------------
# CONFIG - the only things that change from day to day
# ---------------------------------------------------------------------------
INPUT_FILE = "Day_Four.xlsx"
OUT_PREFIX = "day4"
TITLE = "Day 4 Livestock Production Practices"
DATA_SOURCE = "CFHF Evaluation Data 2025/2026"


if __name__ == "__main__":
    df = load_data(INPUT_FILE)
    clean, note, n_base, n_end = clean_pairs(df, DATA_SOURCE)
    print(note)

    summary = summarize(clean)
    print(summary[["Question", "Label", "N", "Baseline_Pct", "Endline_Pct", "Change"]]
          .to_string(index=False))

    reason_agg = reason_breakdown_not_doing(clean)

    chart_stacked(summary, note, TITLE, f"{OUT_PREFIX}_1_stacked_baseline_endline.png")
    chart_dumbbell(summary, note, TITLE, f"{OUT_PREFIX}_2_dumbbell.png")
    chart_diverging(summary, note, TITLE, f"{OUT_PREFIX}_3_diverging_change.png")
    chart_top_reasons_overall(reason_agg, DATA_SOURCE, TITLE,
                               f"{OUT_PREFIX}_4_top_reasons_overall.png")
    chart_reason_mix_weak(reason_agg, summary, DATA_SOURCE, TITLE,
                           f"{OUT_PREFIX}_5_reason_mix_weak_practices.png")

    print("\nAll charts saved.")
