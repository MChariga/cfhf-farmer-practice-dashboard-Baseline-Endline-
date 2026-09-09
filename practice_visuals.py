"""
Day 1 (Soil Health) - Practice Adoption Visuals
================================================
Reads the Individual_Responses sheet, cleans baseline/endline pairs with
missing data, and produces several ways to visualize:
  1. Paired stacked bar (Baseline vs Endline, Yes/No) - matches the style shared
  2. Dumbbell / slope chart - cleaner alternative for many categories
  3. Diverging bar chart of net change (pp) - simplest "headline" view
  4. Aggregate reasons for non-adoption (top reasons across all practices)
  5. Reason mix for the weakest-adopted practices (stacked bar)

Just change INPUT_FILE below to point at your workbook and run:
    python3 practice_visuals.py
Charts are saved as PNGs in the same folder.
"""

import textwrap
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.lines import Line2D


def wrap_label(text, width=42):
    """Wrap long text onto multiple lines instead of cutting it off with '...'."""
    return "\n".join(textwrap.wrap(str(text), width=width))

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------
INPUT_FILE = "Day_one.xlsx"          # <-- change to your file path
SHEET_RESPONSES = "Individual_Responses"
SHEET_CATEGORY = "Category_Breakdown"
OUT_PREFIX = "day1"
DATA_SOURCE = "CFHF Evaluation Data 2025/2026"

# Colors matched to the reference chart style
COLOR_BASELINE_NO = "#D9D9D9"
COLOR_BASELINE_YES = "#1F77B4"
COLOR_ENDLINE_NO = "#8C8C8C"
COLOR_ENDLINE_YES = "#F2A007"
COLOR_UP = "#2CA02C"
COLOR_DOWN = "#D62728"

plt.rcParams.update({
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "font.size": 11,
})

# ---------------------------------------------------------------------------
# 1. LOAD + CLEAN
# ---------------------------------------------------------------------------
def load_data(path):
    df = pd.read_excel(path, sheet_name=SHEET_RESPONSES, header=2)
    # Expected columns: Question, Question_Text, Farmer Name, Organization,
    # County, Farmer_Membership, Baseline, Endline_Code, Status, Category, Narrative
    df = df.rename(columns={"Endline_Code": "Endline"})
    df = df[df["Question"].notna()].copy()

    # Some cells contain the literal string "Null" / "N/A" / "" instead of a
    # true blank cell. Normalize all of these to real NaN, then coerce to
    # numeric so a "not a number" value in either column is caught cleanly.
    for col in ["Baseline", "Endline"]:
        df[col] = df[col].replace(
            to_replace=r"(?i)^\s*(null|n/?a|none|missing)?\s*$",
            value=np.nan, regex=True
        )
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # --- De-duplicate farmer identity -------------------------------------
    # A "farmer" is defined by Name + Organization + County together, not by
    # name alone (two different real farmers could share a first/last name,
    # while the same farmer should never be double-counted just because
    # their row was entered twice). Build a single key from all three,
    # trimmed and case-normalized so "Jane Doe " and "jane doe" match.
    for col in ["Farmer Name", "Organization", "County"]:
        df[col] = df[col].astype(str).str.strip()

    df["Farmer_Key"] = (
        df["Farmer Name"].str.lower() + "|" +
        df["Organization"].str.lower() + "|" +
        df["County"].str.lower()
    )

    before = len(df)
    df = df.drop_duplicates(subset=["Farmer_Key", "Question"], keep="first").copy()
    removed = before - len(df)
    if removed > 0:
        print(f"Removed {removed} duplicate farmer-question row(s) "
              f"(same Name + Organization + County counted more than once).")

    return df


def clean_pairs(df):
    """
    Keep only farmer x question rows where BOTH Baseline and Endline are
    present. If either value is missing, the whole pair is dropped, so
    Baseline and Endline always end up compared on the exact same n - never
    a farmer counted in one round's percentage but not the other's.

    Farmers are identified by Farmer_Key (Name + Organization + County), not
    name alone, so a farmer is dropped entirely (from both rounds) if ANY of
    their 14 answers is missing on either side - every practice bar in the
    chart then reports the same n.
    """
    total_farmers = df["Farmer_Key"].nunique()

    farmers_missing_either = df.loc[
        df["Baseline"].isna() | df["Endline"].isna(), "Farmer_Key"
    ].unique()

    n_matched = total_farmers - len(farmers_missing_either)

    clean = df[~df["Farmer_Key"].isin(farmers_missing_either)].copy()

    note = (f"Baseline: n={n_matched} "
            f"({len(farmers_missing_either)} excluded due to missing data) | "
            f"Endline: n={n_matched} "
            f"({len(farmers_missing_either)} excluded due to missing data) | "
            f"Data source: {DATA_SOURCE}")

    return clean, note, n_matched, n_matched


def summarize(clean):
    """One row per practice: baseline % yes, endline % yes, change (pp)."""
    rows = []
    for q, g in clean.groupby("Question"):
        label = g["Question_Text"].iloc[0]
        n = len(g)
        base_pct = g["Baseline"].mean() * 100
        end_pct = g["Endline"].mean() * 100
        rows.append({
            "Question": q,
            "Label": label,
            "N": n,
            "Baseline_Pct": base_pct,
            "Endline_Pct": end_pct,
            "Change": end_pct - base_pct,
        })
    out = pd.DataFrame(rows).sort_values("Change", ascending=False).reset_index(drop=True)
    return out


# Short, chart-friendly labels (edit to taste)
SHORT_LABELS = {
    "Q1": "Leave.Crop.Residue",
    "Q2": "Plant.Cover.Crop",
    "Q3": "Plough.Back.Cover.Crop",
    "Q4": "Compost.Manure",
    "Q5": "Boma.Compost",
    "Q6": "Garden.Compost",
    "Q7": "Bokashi.Compost",
    "Q8": "Vermicompost",
    "Q9": "Protect.Compost.Quality",
    "Q10": "Animal.Urine",
    "Q11": "Human.Urine",
    "Q12": "Tithonia.Tea",
    "Q13": "Manure.Tea",
    "Q14": "Organic.Residue/Legume.For.Striga",
}


# ---------------------------------------------------------------------------
# CHART 1 - Paired stacked bar (matches the reference style)
# ---------------------------------------------------------------------------
def chart_stacked(summary, note, outfile):
    df = summary.copy()
    df["ShortLabel"] = df["Question"].map(SHORT_LABELS).fillna(df["Question"])
    df = df.sort_values("Change", ascending=True).reset_index(drop=True)  # so largest change plots at top

    fig, ax = plt.subplots(figsize=(10, 0.55 * len(df) + 2))
    y = np.arange(len(df))
    bar_h = 0.38

    # Baseline row (lower), Endline row (upper) for each practice
    ax.barh(y - bar_h/2 - 0.02, df["Baseline_Pct"], height=bar_h,
            color=COLOR_BASELINE_YES, label="Baseline - Yes", zorder=3)
    ax.barh(y - bar_h/2 - 0.02, 100 - df["Baseline_Pct"], left=df["Baseline_Pct"],
            height=bar_h, color=COLOR_BASELINE_NO, label="Baseline - No", zorder=3)

    ax.barh(y + bar_h/2 + 0.02, df["Endline_Pct"], height=bar_h,
            color=COLOR_ENDLINE_YES, label="Endline - Yes", zorder=3)
    ax.barh(y + bar_h/2 + 0.02, 100 - df["Endline_Pct"], left=df["Endline_Pct"],
            height=bar_h, color=COLOR_ENDLINE_NO, label="Endline - No", zorder=3)

    # Change labels at right edge
    for yi, chg in zip(y, df["Change"]):
        color = COLOR_UP if chg >= 0 else COLOR_DOWN
        sign = "+" if chg >= 0 else ""
        ax.text(103, yi, f"{sign}{chg:.1f}%", va="center", ha="left",
                color=color, fontweight="bold", fontsize=9)

    ax.set_yticks(y)
    ax.set_yticklabels(df["ShortLabel"])
    ax.set_xlim(0, 118)
    ax.set_xlabel("% of Farmers")
    ax.set_title("Soil Health Practices Adoption: Baseline vs Endline (Yes vs No)\n"
                  "Ranked by change in 'Yes' adoption - largest change first",
                  loc="left", fontsize=13)

    handles = [
        mpatches.Patch(color=COLOR_BASELINE_NO, label="Baseline - No"),
        mpatches.Patch(color=COLOR_BASELINE_YES, label="Baseline - Yes"),
        mpatches.Patch(color=COLOR_ENDLINE_NO, label="Endline - No"),
        mpatches.Patch(color=COLOR_ENDLINE_YES, label="Endline - Yes"),
    ]
    ax.legend(handles=handles, title="Round & Response", loc="center left",
              bbox_to_anchor=(1.15, 0.5), frameon=False)

    ax.spines[["top", "right", "left"]].set_visible(False)
    fig.text(0.01, 0.01, note, fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.03, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 2 - Dumbbell / slope chart (cleaner alternative for many categories)
# ---------------------------------------------------------------------------
def chart_dumbbell(summary, note, outfile):
    df = summary.copy()
    df["ShortLabel"] = df["Question"].map(SHORT_LABELS).fillna(df["Question"])
    df = df.sort_values("Change", ascending=True).reset_index(drop=True)

    fig, ax = plt.subplots(figsize=(9, 0.5 * len(df) + 2))
    y = np.arange(len(df))

    for yi, base, end, chg in zip(y, df["Baseline_Pct"], df["Endline_Pct"], df["Change"]):
        color = COLOR_UP if chg >= 0 else COLOR_DOWN
        ax.plot([base, end], [yi, yi], color=color, linewidth=2, zorder=2, alpha=0.7)

    ax.scatter(df["Baseline_Pct"], y, s=90, color=COLOR_BASELINE_YES,
               zorder=3, label="Baseline", edgecolor="white", linewidth=0.8)
    ax.scatter(df["Endline_Pct"], y, s=90, color=COLOR_ENDLINE_YES,
               zorder=3, label="Endline", edgecolor="white", linewidth=0.8)

    for yi, base, end, chg in zip(y, df["Baseline_Pct"], df["Endline_Pct"], df["Change"]):
        sign = "+" if chg >= 0 else ""
        color = COLOR_UP if chg >= 0 else COLOR_DOWN
        x_label = max(base, end) + 3
        ax.text(x_label, yi, f"{sign}{chg:.1f} pp", va="center", ha="left",
                fontsize=9, color=color, fontweight="bold")

    ax.set_yticks(y)
    ax.set_yticklabels(df["ShortLabel"])
    ax.set_xlim(0, 115)
    ax.set_xlabel("% of Farmers Doing the Practice")
    ax.set_title("Practice Adoption: Baseline -> Endline (Dumbbell View)", loc="left", fontsize=13)
    ax.legend(loc="lower right", frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    ax.xaxis.grid(True, color="#EEEEEE")
    ax.set_axisbelow(True)
    fig.text(0.01, 0.01, note, fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.03, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 3 - Diverging bar of net change (simplest headline view)
# ---------------------------------------------------------------------------
def chart_diverging(summary, note, outfile):
    df = summary.copy()
    df["ShortLabel"] = df["Question"].map(SHORT_LABELS).fillna(df["Question"])
    df = df.sort_values("Change", ascending=True).reset_index(drop=True)

    fig, ax = plt.subplots(figsize=(8, 0.45 * len(df) + 2))
    y = np.arange(len(df))
    colors = [COLOR_UP if c >= 0 else COLOR_DOWN for c in df["Change"]]

    ax.barh(y, df["Change"], color=colors, height=0.6, zorder=3)
    span = df["Change"].max() - df["Change"].min()
    pad = max(span * 0.04, 1.0)
    for yi, chg in zip(y, df["Change"]):
        sign = "+" if chg >= 0 else ""
        ha = "left" if chg >= 0 else "right"
        offset = pad if chg >= 0 else -pad
        ax.text(chg + offset, yi, f"{sign}{chg:.1f} pp", va="center", ha=ha, fontsize=9)

    ax.axvline(0, color="black", linewidth=0.8)
    ax.set_xlim(df["Change"].min() - span * 0.22, df["Change"].max() + span * 0.22)
    ax.set_yticks(y)
    ax.set_yticklabels(df["ShortLabel"])
    ax.tick_params(axis="y", pad=8)
    ax.set_xlabel("Change in Adoption, Baseline to Endline (percentage points)")
    ax.set_title("Net Change in Practice Adoption", loc="left", fontsize=13)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.xaxis.grid(True, color="#EEEEEE")
    ax.set_axisbelow(True)
    fig.text(0.01, 0.01, note, fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.03, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 4 - Aggregate reasons for non-adoption, across ALL practices
# ---------------------------------------------------------------------------
def chart_top_reasons_overall(cat_path, outfile, top_n=12):
    cb = pd.read_excel(cat_path, sheet_name=SHEET_CATEGORY, header=2)
    cb = cb[cb["Question"].notna()]
    not_doing = cb[cb["Status"] == "Not doing"]

    agg = (not_doing.groupby("Category")["Num_Farmers"]
           .sum().sort_values(ascending=False).head(top_n))
    total = not_doing["Num_Farmers"].sum()
    pct = agg / total * 100

    fig, ax = plt.subplots(figsize=(11, 0.65 * len(agg) + 1.5))
    y = np.arange(len(agg))[::-1]
    ax.barh(y, agg.values, color="#B5651D", zorder=3)
    for yi, val, p in zip(y, agg.values, pct.values):
        ax.text(val + total * 0.005, yi, f"{val} ({p:.1f}%)", va="center", fontsize=9)

    ax.set_yticks(y)
    ax.set_yticklabels([wrap_label(lbl, width=42) for lbl in agg.index], fontsize=9.5)
    ax.set_xlabel("Number of farmer-practice instances")
    ax.set_title(f"Top {top_n} Reasons for Not Adopting a Practice\n(aggregated across all 14 practices)",
                 loc="left", fontsize=13)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.xaxis.grid(True, color="#EEEEEE")
    ax.set_axisbelow(True)
    fig.text(0.01, 0.01, f"Data source: {DATA_SOURCE}", fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.03, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 5 - Reason mix for the weakest-adopted practices (100% stacked bar)
# ---------------------------------------------------------------------------
def chart_reason_mix_weak(cat_path, summary, outfile, n_weak=7, top_reasons=4):
    """
    Stacked 100% bar per weak practice, but with a FIXED color per reason
    category (so the same color always means the same reason across every
    row) plus a shared legend - more readable than coloring by rank position.
    """
    cb = pd.read_excel(cat_path, sheet_name=SHEET_CATEGORY, header=2)
    cb = cb[cb["Question"].notna()]
    not_doing = cb[cb["Status"] == "Not doing"].copy()

    weak_qs = summary.sort_values("Endline_Pct").head(n_weak)["Question"].tolist()
    weak_labels = {q: SHORT_LABELS.get(q, q) for q in weak_qs}

    # First pass: work out each practice's top reasons + "Other reasons"
    per_practice = {}
    all_categories = []
    for q in weak_qs:
        sub = not_doing[not_doing["Question"] == q].sort_values("Num_Farmers", ascending=False)
        total = sub["Num_Farmers"].sum()
        top = sub.head(top_reasons).copy()
        other_n = total - top["Num_Farmers"].sum()
        cats = list(top["Category"])
        vals = list(top["Num_Farmers"])
        if other_n > 0:
            cats.append("Other reasons")
            vals.append(other_n)
        per_practice[q] = (cats, vals, total)
        all_categories.extend([c for c in cats if c != "Other reasons"])

    # Fixed color per distinct category (consistent across rows), grey for "Other"
    distinct = list(dict.fromkeys(all_categories))  # preserve first-seen order
    cmap = plt.cm.tab20.colors
    color_map = {cat: cmap[i % len(cmap)] for i, cat in enumerate(distinct)}
    color_map["Other reasons"] = "#C7C7C7"

    fig, ax = plt.subplots(figsize=(11, 0.7 * n_weak + 2.2))
    y_pos = np.arange(n_weak)

    for i, q in enumerate(weak_qs):
        cats, vals, total = per_practice[q]
        left = 0
        for cat, val in zip(cats, vals):
            pct = val / total * 100
            color = color_map[cat]
            ax.barh(i, pct, left=left, color=color, edgecolor="white", height=0.6, zorder=3)
            if pct > 7:
                ax.text(left + pct / 2, i, f"{pct:.0f}%", va="center", ha="center",
                        fontsize=8, color="black" if cat == "Other reasons" else "white")
            left += pct

    ax.set_yticks(y_pos)
    ax.set_yticklabels([weak_labels[q] for q in weak_qs])
    ax.set_xlim(0, 100)
    ax.set_xlabel("% of non-adopters citing each reason")
    ax.set_title(f"Why Farmers Are Not Adopting the {n_weak} Weakest Practices",
                 loc="left", fontsize=13)
    ax.spines[["top", "right", "left"]].set_visible(False)

    # Legend as a vertical list to the right of the plot, full text wrapped
    # onto multiple lines rather than cut off with "..." - same layout style
    # as the stacked baseline/endline chart.
    legend_handles = [mpatches.Patch(color=color_map[c], label=wrap_label(c, width=40))
                       for c in distinct]
    legend_handles.append(mpatches.Patch(color=color_map["Other reasons"],
                                          label="Other reasons (smaller categories)"))
    ax.legend(handles=legend_handles, loc="center left", bbox_to_anchor=(1.02, 0.5),
              ncol=1, frameon=False, fontsize=8.5, labelspacing=1.1)

    fig.text(0.01, 0.01, f"Data source: {DATA_SOURCE}", fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.02, 0.98, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    df = load_data(INPUT_FILE)
    clean, note, n_base, n_end = clean_pairs(df)
    print(note)

    summary = summarize(clean)
    print(summary[["Question", "Label", "N", "Baseline_Pct", "Endline_Pct", "Change"]]
          .to_string(index=False))

    chart_stacked(summary, note, f"{OUT_PREFIX}_1_stacked_baseline_endline.png")
    chart_dumbbell(summary, note, f"{OUT_PREFIX}_2_dumbbell.png")
    chart_diverging(summary, note, f"{OUT_PREFIX}_3_diverging_change.png")
    chart_top_reasons_overall(INPUT_FILE, f"{OUT_PREFIX}_4_top_reasons_overall.png")
    chart_reason_mix_weak(INPUT_FILE, summary, f"{OUT_PREFIX}_5_reason_mix_weak_practices.png")

    print("\nAll charts saved.")
