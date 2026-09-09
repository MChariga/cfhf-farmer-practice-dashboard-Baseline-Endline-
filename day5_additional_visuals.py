"""
Day 5 Climate Change Adaptation Practices - Additional Non-Bar Visuals
=======================================================================
Quadrant scatter, alluvial transition diagram, and treemap - same charts as
Day 1's additional_visuals.py, pointed at the Day_Five.xlsx workbook via mel_common.

Run with:
    python3 day5_additional_visuals.py
"""

from mel_common import (
    load_data, clean_pairs, summarize, reason_breakdown_not_doing,
    chart_quadrant_scatter, chart_alluvial, chart_treemap_reasons,
)

INPUT_FILE = "Day_Five.xlsx"
OUT_PREFIX = "day5"
TITLE = "Day 5 Climate Change Adaptation Practices"
DATA_SOURCE = "CFHF Evaluation Data 2025/2026"

# A practice to feature on its own in the alluvial diagram, in addition to
# the all-practices combined view. Change this to any "Q1".."Qn" code.
FOCUS_QUESTION = "Q5"


if __name__ == "__main__":
    df = load_data(INPUT_FILE)
    clean, note, n_base, n_end = clean_pairs(df, DATA_SOURCE)
    summary = summarize(clean)
    reason_agg = reason_breakdown_not_doing(clean)

    chart_quadrant_scatter(summary, note, TITLE, f"{OUT_PREFIX}_6_quadrant_scatter.png")

    focus_label = dict(zip(summary["Question"], summary["ShortLabel"])).get(FOCUS_QUESTION, FOCUS_QUESTION)
    chart_alluvial(clean, note, f"{OUT_PREFIX}_7_alluvial_all_practices.png",
                    question=None,
                    title=f"Farmer Transitions Across All Practices Combined: {TITLE}")
    chart_alluvial(clean, note, f"{OUT_PREFIX}_8_alluvial_{FOCUS_QUESTION.lower()}.png",
                    question=FOCUS_QUESTION,
                    title=f"Farmer Transitions: {focus_label}")

    chart_treemap_reasons(reason_agg, DATA_SOURCE, TITLE, f"{OUT_PREFIX}_9_treemap_reasons.png")

    print("All additional charts saved.")
