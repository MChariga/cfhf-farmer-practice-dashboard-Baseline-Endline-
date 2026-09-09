"""
mel_common.py
=============
Shared loading, cleaning, and charting engine for the "Type 2" workbooks
(Day 2 - Day 5), which all store farmer-level detail in an
Individual_Transitions sheet rather than Day 1's Individual_Responses sheet.

Every dayN_practice_visuals.py / dayN_additional_visuals.py file imports
from here, so the cleaning rules and chart appearance stay identical across
every day - only the input file and a few labels change per day.

Column layout differs slightly file to file (Day 2 and Day 5 include
Question_Text, County, and Farmer_Membership directly in Individual_
Transitions; Day 3 and Day 4 do not), so the loader auto-detects the header
row and whichever columns are actually present, and falls back to the
Question_Uptake sheet for question text when it's missing from Individual_
Transitions.
"""

import re
import textwrap

import numpy as np
import pandas as pd
import openpyxl
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import Rectangle, PathPatch
from matplotlib.path import Path

SHEET_TRANSITIONS = "Individual_Transitions"
SHEET_QUESTION_UPTAKE = "Question_Uptake"

# Colors - identical across every day's charts
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


def wrap_label(text, width=42):
    """Wrap long text onto multiple lines instead of cutting it off with '...'."""
    return "\n".join(textwrap.wrap(str(text), width=width))


def auto_short_label(text, max_words=4, max_len=36):
    """
    Turn a full question sentence into a short "Word.Word.Word" chart label,
    the same style as the manually written labels used for Day 1
    (e.g. "Boma.Compost"). Strips bracketed notes and leading question
    phrasing, then keeps the first few meaningful words - trimming by whole
    words only, never mid-word, so labels never end on a cut-off fragment.
    """
    if text is None:
        return ""
    t = re.sub(r"\[.*?\]", "", str(text))          # drop [REVERSE-WORDED: ...] notes
    t = re.sub(r"\(.*?\)", "", t)                   # drop parenthetical asides
    t = t.replace("?", "").strip()
    t = re.sub(r"(?i)^do you\s+", "", t)
    t = re.sub(r"(?i)^have you\s+", "", t)
    t = re.sub(r"(?i)^did you\s+", "", t)
    t = re.sub(r"(?i)^does the farmer\s+", "", t)
    t = re.sub(r"(?i)^are you\s+", "", t)
    words = [w.strip(",.") for w in re.split(r"[\s/]+", t) if w.strip(",.")]
    stopwords = {"a", "an", "the", "to", "for", "of", "on", "in", "and", "or"}

    kept = []
    for w in words:
        if len(kept) >= max_words:
            break
        if w.lower() in stopwords and kept:
            continue
        candidate = kept + [w]
        if len(".".join(x.capitalize() for x in candidate)) > max_len and kept:
            break
        kept.append(w)

    label = ".".join(w.capitalize() for w in kept if w)
    return label if label else str(text)[:max_len]


def find_header_row(path, sheet, key="Question", max_scan=10):
    """Return the 0-based row index whose first cell equals `key`."""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet]
    for i, row in enumerate(ws.iter_rows(values_only=True, max_row=max_scan)):
        if row and row[0] == key:
            return i
    raise ValueError(f"Could not find a header row starting with {key!r} in '{sheet}'")


def load_question_text_lookup(path):
    """Question -> Question_Text map, read from Question_Uptake (always present,
    even on the files where Individual_Transitions itself omits Question_Text)."""
    hdr = find_header_row(path, SHEET_QUESTION_UPTAKE)
    df = pd.read_excel(path, sheet_name=SHEET_QUESTION_UPTAKE, header=hdr)
    df = df.iloc[:, :2]
    df.columns = ["Question", "Question_Text"]
    df = df[df["Question"].astype(str).str.match(r"^Q\d+$", na=False)]
    df = df.drop_duplicates(subset="Question")
    return dict(zip(df["Question"], df["Question_Text"]))


def load_data(path):
    """
    Load Individual_Transitions into a standardized DataFrame with columns:
    Question, Question_Text, Farmer Name, Organization, County,
    Baseline, Endline, Reason_Category, Farmer_Key.

    Handles both column layouts seen across Day 2-5 (with or without
    Question_Text / County / Farmer_Membership present directly in the sheet).
    """
    hdr = find_header_row(path, SHEET_TRANSITIONS)
    df = pd.read_excel(path, sheet_name=SHEET_TRANSITIONS, header=hdr)
    df = df[df["Question"].notna()].copy()

    if "Question_Text" not in df.columns:
        lookup = load_question_text_lookup(path)
        df["Question_Text"] = df["Question"].map(lookup)

    if "County" not in df.columns:
        df["County"] = "Unknown"

    if "Farmer_Membership" not in df.columns:
        df["Farmer_Membership"] = None

    # Some cells contain the literal string "N/A" / "Null" / "" instead of a
    # true blank cell - normalize all of these to real NaN, then coerce to
    # numeric so a non-numeric value in either column is caught cleanly.
    for col in ["Baseline", "Endline"]:
        df[col] = df[col].replace(
            to_replace=r"(?i)^\s*(null|n/?a|none|missing)?\s*$",
            value=np.nan, regex=True
        )
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # --- De-duplicate farmer identity -------------------------------------
    # A "farmer" is Name + Organization + County together (falls back to
    # Name + Organization on files with no County column), trimmed and
    # case-normalized, so the same person is never double-counted just
    # because a row was entered twice.
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

    keep_cols = ["Question", "Question_Text", "Farmer Name", "Organization",
                 "County", "Farmer_Membership", "Baseline", "Endline", "Reason_Category", "Farmer_Key"]
    return df[keep_cols]


def clean_pairs(df, data_source):
    """
    Keep only farmer x question rows where BOTH Baseline and Endline are
    present. A farmer (identified by Farmer_Key) is dropped entirely, from
    every question, if ANY of their answers is missing on either side - so
    Baseline and Endline are always compared on the exact same n, and every
    practice bar in the chart reports that same n.
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
            f"Data source: {data_source}")

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
            "ShortLabel": auto_short_label(label),
            "N": n,
            "Baseline_Pct": base_pct,
            "Endline_Pct": end_pct,
            "Change": end_pct - base_pct,
        })
    out = pd.DataFrame(rows).sort_values("Change", ascending=False).reset_index(drop=True)
    return out


def reason_breakdown_not_doing(clean):
    """
    Category_Breakdown-equivalent: for every practice, how many farmers cited
    each Reason_Category while NOT doing the practice at endline (Endline==0).
    Mirrors Day 1's 'Not doing' reason categories, built here directly from
    Individual_Transitions instead of a separate breakdown sheet.
    """
    not_doing = clean[clean["Endline"] == 0].copy()
    not_doing["Reason_Category"] = not_doing["Reason_Category"].fillna("No reason recorded")
    agg = (not_doing.groupby(["Question", "Reason_Category"])
           .size().reset_index(name="Num_Farmers"))
    return agg


# ---------------------------------------------------------------------------
# CHART 1 - Paired stacked bar (Baseline vs Endline, Yes vs No)
# ---------------------------------------------------------------------------
def chart_stacked(summary, note, title, outfile):
    df = summary.sort_values("Change", ascending=True).reset_index(drop=True)

    fig, ax = plt.subplots(figsize=(10, 0.55 * len(df) + 2))
    y = np.arange(len(df))
    bar_h = 0.38

    ax.barh(y - bar_h/2 - 0.02, df["Baseline_Pct"], height=bar_h,
            color=COLOR_BASELINE_YES, label="Baseline - Yes", zorder=3)
    ax.barh(y - bar_h/2 - 0.02, 100 - df["Baseline_Pct"], left=df["Baseline_Pct"],
            height=bar_h, color=COLOR_BASELINE_NO, label="Baseline - No", zorder=3)
    ax.barh(y + bar_h/2 + 0.02, df["Endline_Pct"], height=bar_h,
            color=COLOR_ENDLINE_YES, label="Endline - Yes", zorder=3)
    ax.barh(y + bar_h/2 + 0.02, 100 - df["Endline_Pct"], left=df["Endline_Pct"],
            height=bar_h, color=COLOR_ENDLINE_NO, label="Endline - No", zorder=3)

    for yi, chg in zip(y, df["Change"]):
        color = COLOR_UP if chg >= 0 else COLOR_DOWN
        sign = "+" if chg >= 0 else ""
        ax.text(103, yi, f"{sign}{chg:.1f}%", va="center", ha="left",
                color=color, fontweight="bold", fontsize=9)

    ax.set_yticks(y)
    ax.set_yticklabels(df["ShortLabel"])
    ax.set_xlim(0, 118)
    ax.set_xlabel("% of Farmers")
    ax.set_title(f"{title}: Baseline vs Endline (Yes vs No)\n"
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
# CHART 2 - Dumbbell / slope chart
# ---------------------------------------------------------------------------
def chart_dumbbell(summary, note, title, outfile):
    df = summary.sort_values("Change", ascending=True).reset_index(drop=True)

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
        ax.text(max(base, end) + 3, yi, f"{sign}{chg:.1f} pp", va="center", ha="left",
                fontsize=9, color=color, fontweight="bold")

    ax.set_yticks(y)
    ax.set_yticklabels(df["ShortLabel"])
    ax.set_xlim(0, 115)
    ax.set_xlabel("% of Farmers Doing the Practice")
    ax.set_title(f"{title}: Baseline -> Endline (Dumbbell View)", loc="left", fontsize=13)
    ax.legend(loc="lower right", frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    ax.xaxis.grid(True, color="#EEEEEE")
    ax.set_axisbelow(True)
    fig.text(0.01, 0.01, note, fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.03, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 3 - Diverging bar of net change
# ---------------------------------------------------------------------------
def chart_diverging(summary, note, title, outfile):
    df = summary.sort_values("Change", ascending=True).reset_index(drop=True)

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
    ax.set_title(f"Net Change in Practice Adoption: {title}", loc="left", fontsize=13)
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
def chart_top_reasons_overall(reason_agg, data_source, title, outfile, top_n=12):
    agg = (reason_agg.groupby("Reason_Category")["Num_Farmers"]
           .sum().sort_values(ascending=False).head(top_n))
    total = reason_agg["Num_Farmers"].sum()
    pct = agg / total * 100

    fig, ax = plt.subplots(figsize=(11, 0.65 * len(agg) + 1.5))
    y = np.arange(len(agg))[::-1]
    ax.barh(y, agg.values, color="#B5651D", zorder=3)
    for yi, val, p in zip(y, agg.values, pct.values):
        ax.text(val + total * 0.005, yi, f"{val} ({p:.1f}%)", va="center", fontsize=9)

    ax.set_yticks(y)
    ax.set_yticklabels([wrap_label(lbl, width=42) for lbl in agg.index], fontsize=9.5)
    ax.set_xlabel("Number of farmer-practice instances")
    ax.set_title(f"Top {top_n} Reasons for Not Adopting a Practice: {title}\n"
                 "(aggregated across all practices)", loc="left", fontsize=13)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.xaxis.grid(True, color="#EEEEEE")
    ax.set_axisbelow(True)
    fig.text(0.01, 0.01, f"Data source: {data_source}", fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.03, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 5 - Reason mix for the weakest-adopted practices (100% stacked bar)
# ---------------------------------------------------------------------------
def chart_reason_mix_weak(reason_agg, summary, data_source, title, outfile,
                           n_weak=7, top_reasons=4):
    weak_qs = summary.sort_values("Endline_Pct").head(n_weak)["Question"].tolist()
    label_map = dict(zip(summary["Question"], summary["ShortLabel"]))

    per_practice, all_categories = {}, []
    for q in weak_qs:
        sub = (reason_agg[reason_agg["Question"] == q]
               .sort_values("Num_Farmers", ascending=False))
        total = sub["Num_Farmers"].sum()
        if total == 0:
            per_practice[q] = ([], [], 0)
            continue
        top = sub.head(top_reasons).copy()
        other_n = total - top["Num_Farmers"].sum()
        cats = list(top["Reason_Category"])
        vals = list(top["Num_Farmers"])
        if other_n > 0:
            cats.append("Other reasons")
            vals.append(other_n)
        per_practice[q] = (cats, vals, total)
        all_categories.extend([c for c in cats if c != "Other reasons"])

    distinct = list(dict.fromkeys(all_categories))
    cmap = plt.cm.tab20.colors
    color_map = {cat: cmap[i % len(cmap)] for i, cat in enumerate(distinct)}
    color_map["Other reasons"] = "#C7C7C7"

    fig, ax = plt.subplots(figsize=(11, 0.7 * n_weak + 2.2))
    y_pos = np.arange(n_weak)

    for i, q in enumerate(weak_qs):
        cats, vals, total = per_practice[q]
        if total == 0:
            continue
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
    ax.set_yticklabels([label_map[q] for q in weak_qs])
    ax.set_xlim(0, 100)
    ax.set_xlabel("% of non-adopters citing each reason")
    ax.set_title(f"Why Farmers Are Not Adopting the {n_weak} Weakest Practices: {title}",
                 loc="left", fontsize=13)
    ax.spines[["top", "right", "left"]].set_visible(False)

    legend_handles = [mpatches.Patch(color=color_map[c], label=wrap_label(c, width=40))
                       for c in distinct]
    legend_handles.append(mpatches.Patch(color=color_map["Other reasons"],
                                          label="Other reasons (smaller categories)"))
    ax.legend(handles=legend_handles, loc="center left", bbox_to_anchor=(1.02, 0.5),
              ncol=1, frameon=False, fontsize=8.5, labelspacing=1.1)

    fig.text(0.01, 0.01, f"Data source: {data_source}", fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.02, 0.98, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 6 - Quadrant scatter (baseline % vs endline %)
# ---------------------------------------------------------------------------
def chart_quadrant_scatter(summary, note, title, outfile):
    df = summary.copy()

    fig, ax = plt.subplots(figsize=(9, 8))
    ax.plot([0, 100], [0, 100], color="gray", linestyle="--", linewidth=1, zorder=1)
    ax.fill_between([0, 100], [0, 100], [100, 100], color=COLOR_UP, alpha=0.05, zorder=0)
    ax.fill_between([0, 100], [0, 0], [0, 100], color=COLOR_DOWN, alpha=0.05, zorder=0)

    colors = [COLOR_UP if c >= 0 else COLOR_DOWN for c in df["Change"]]
    ax.scatter(df["Baseline_Pct"], df["Endline_Pct"], s=140, c=colors,
               edgecolor="white", linewidth=1.2, zorder=3)

    for _, row in df.iterrows():
        dx = 2.5
        dy = 2.5 if row["Change"] >= 0 else -2.5
        ax.annotate(row["ShortLabel"], (row["Baseline_Pct"], row["Endline_Pct"]),
                    xytext=(row["Baseline_Pct"] + dx, row["Endline_Pct"] + dy),
                    fontsize=8.5, va="center", ha="left")

    ax.text(8, 95, "Improved\n(above the line)", fontsize=10, color=COLOR_UP,
             fontweight="bold", va="top")
    ax.text(70, 8, "Declined\n(below the line)", fontsize=10, color=COLOR_DOWN,
             fontweight="bold", va="bottom", ha="left")

    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.set_xlabel("Baseline: % of Farmers Doing the Practice")
    ax.set_ylabel("Endline: % of Farmers Doing the Practice")
    ax.set_title(f"All Practices at a Glance: Baseline vs Endline - {title}", loc="left", fontsize=13)
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(True, color="#EEEEEE")
    ax.set_axisbelow(True)
    fig.text(0.01, 0.01, note, fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.03, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 7/8 - Alluvial / transition diagram
# ---------------------------------------------------------------------------
def _bezier_ribbon(ax, x0, y0_top, y0_bot, x1, y1_top, y1_bot, color, alpha=0.6):
    xm = (x0 + x1) / 2
    verts = [
        (x0, y0_top), (xm, y0_top), (xm, y1_top), (x1, y1_top),
        (x1, y1_bot), (xm, y1_bot), (xm, y0_bot), (x0, y0_bot),
        (x0, y0_top),
    ]
    codes = [Path.MOVETO, Path.CURVE4, Path.CURVE4, Path.CURVE4,
             Path.LINETO, Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.CLOSEPOLY]
    ax.add_patch(PathPatch(Path(verts, codes), facecolor=color, edgecolor="none",
                            alpha=alpha, zorder=2))


def compute_transitions(clean, question=None):
    df = clean if question is None else clean[clean["Question"] == question]
    stayed_not_doing = int(((df["Baseline"] == 0) & (df["Endline"] == 0)).sum())
    stopped = int(((df["Baseline"] == 1) & (df["Endline"] == 0)).sum())
    started = int(((df["Baseline"] == 0) & (df["Endline"] == 1)).sum())
    stayed_doing = int(((df["Baseline"] == 1) & (df["Endline"] == 1)).sum())
    return stayed_not_doing, stopped, started, stayed_doing


def chart_alluvial(clean, note, outfile, question=None, title=None):
    stayed_not_doing, stopped, started, stayed_doing = compute_transitions(clean, question)

    left_not_doing = stayed_not_doing + started
    left_doing = stopped + stayed_doing
    right_not_doing = stayed_not_doing + stopped
    right_doing = started + stayed_doing

    total = left_not_doing + left_doing
    gap = total * 0.04
    fig, ax = plt.subplots(figsize=(8, 6))
    x0, x1 = 0.15, 0.85

    left_bottom_h, left_top_h = left_not_doing, left_doing
    ax.add_patch(Rectangle((x0 - 0.03, 0), 0.03, left_bottom_h, color=COLOR_BASELINE_YES, alpha=0.9))
    ax.add_patch(Rectangle((x0 - 0.03, left_bottom_h + gap), 0.03, left_top_h, color=COLOR_BASELINE_YES))
    ax.text(x0 - 0.06, left_bottom_h / 2, f"Not doing\n{left_not_doing}", ha="right", va="center", fontsize=9)
    ax.text(x0 - 0.06, left_bottom_h + gap + left_top_h / 2, f"Doing\n{left_doing}", ha="right", va="center", fontsize=9)

    right_bottom_h, right_top_h = right_not_doing, right_doing
    ax.add_patch(Rectangle((x1, 0), 0.03, right_bottom_h, color=COLOR_ENDLINE_YES, alpha=0.9))
    ax.add_patch(Rectangle((x1, right_bottom_h + gap), 0.03, right_top_h, color=COLOR_ENDLINE_YES))
    ax.text(x1 + 0.06, right_bottom_h / 2, f"Not doing\n{right_not_doing}", ha="left", va="center", fontsize=9)
    ax.text(x1 + 0.06, right_bottom_h + gap + right_top_h / 2, f"Doing\n{right_doing}", ha="left", va="center", fontsize=9)

    l_snd_bot, l_snd_top = 0, stayed_not_doing
    l_st_bot, l_st_top = l_snd_top, l_snd_top + started
    left_doing_y = left_bottom_h + gap
    l_sp_bot, l_sp_top = left_doing_y, left_doing_y + stopped
    l_sd_bot, l_sd_top = l_sp_top, l_sp_top + stayed_doing

    r_snd_bot, r_snd_top = 0, stayed_not_doing
    r_sp_bot, r_sp_top = r_snd_top, r_snd_top + stopped
    right_doing_y = right_bottom_h + gap
    r_st_bot, r_st_top = right_doing_y, right_doing_y + started
    r_sd_bot, r_sd_top = r_st_top, r_st_top + stayed_doing

    ribbon_x0, ribbon_x1 = x0, x1 + 0.03
    _bezier_ribbon(ax, ribbon_x0, l_snd_top, l_snd_bot, ribbon_x1, r_snd_top, r_snd_bot, color="#BBBBBB", alpha=0.55)
    _bezier_ribbon(ax, ribbon_x0, l_st_top, l_st_bot, ribbon_x1, r_st_top, r_st_bot, color=COLOR_UP, alpha=0.55)
    _bezier_ribbon(ax, ribbon_x0, l_sp_top, l_sp_bot, ribbon_x1, r_sp_top, r_sp_bot, color=COLOR_DOWN, alpha=0.55)
    _bezier_ribbon(ax, ribbon_x0, l_sd_top, l_sd_bot, ribbon_x1, r_sd_top, r_sd_bot, color=COLOR_BASELINE_YES, alpha=0.55)

    legend_handles = [
        mpatches.Patch(color="#BBBBBB", label=f"Stayed not doing ({stayed_not_doing})"),
        mpatches.Patch(color=COLOR_UP, label=f"Started doing ({started})"),
        mpatches.Patch(color=COLOR_DOWN, label=f"Stopped doing ({stopped})"),
        mpatches.Patch(color=COLOR_BASELINE_YES, label=f"Stayed doing ({stayed_doing})"),
    ]
    ax.legend(handles=legend_handles, loc="upper center", bbox_to_anchor=(0.5, -0.05),
              ncol=2, frameon=False, fontsize=9)

    ax.text(x0 - 0.03, total * 1.03, "BASELINE", ha="center", fontsize=10, fontweight="bold")
    ax.text(x1 + 0.015, total * 1.03, "ENDLINE", ha="center", fontsize=10, fontweight="bold")

    ax.set_xlim(0, 1)
    ax.set_ylim(0, total * 1.1)
    ax.axis("off")
    ax.set_title(title or "Farmer Transitions: Baseline to Endline", loc="left", fontsize=13)
    fig.text(0.01, 0.01, note, fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.05, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()


# ---------------------------------------------------------------------------
# CHART 9 - Treemap of reasons
# ---------------------------------------------------------------------------
def _squarify(sizes, x, y, dx, dy):
    def layoutrow(subset, x, y, dx, dy):
        width = sum(subset) / dy
        rects, cy = [], y
        for s in subset:
            h = s / width
            rects.append({"x": x, "y": cy, "dx": width, "dy": h})
            cy += h
        return rects

    def layoutcol(subset, x, y, dx, dy):
        height = sum(subset) / dx
        rects, cx = [], x
        for s in subset:
            w = s / height
            rects.append({"x": cx, "y": y, "dx": w, "dy": height})
            cx += w
        return rects

    def layout(subset, x, y, dx, dy):
        return layoutrow(subset, x, y, dx, dy) if dx >= dy else layoutcol(subset, x, y, dx, dy)

    def leftover(subset, x, y, dx, dy):
        if dx >= dy:
            width = sum(subset) / dy
            return x + width, y, dx - width, dy
        else:
            height = sum(subset) / dx
            return x, y + height, dx, dy - height

    def worst(subset, x, y, dx, dy):
        rects = layout(subset, x, y, dx, dy)
        return max(max(r["dx"] / r["dy"], r["dy"] / r["dx"]) for r in rects)

    sizes = [float(s) for s in sizes if s > 0]
    if not sizes:
        return []
    if len(sizes) == 1 or min(dx, dy) <= 0:
        return layout(sizes, x, y, dx, dy)

    i = 1
    while i < len(sizes) and worst(sizes[:i], x, y, dx, dy) >= worst(sizes[:i + 1], x, y, dx, dy):
        i += 1

    current, remaining = sizes[:i], sizes[i:]
    placed = layout(current, x, y, dx, dy)
    lx, ly, ldx, ldy = leftover(current, x, y, dx, dy)
    return placed + _squarify(remaining, lx, ly, ldx, ldy)


def chart_treemap_reasons(reason_agg, data_source, title, outfile, top_n=12):
    agg = (reason_agg.groupby("Reason_Category")["Num_Farmers"]
           .sum().sort_values(ascending=False))
    total_all = agg.sum()
    top = agg.head(top_n)
    other = total_all - top.sum()
    if other > 0:
        top = pd.concat([top, pd.Series({"Other reasons (smaller categories)": other})])

    W, H = 100, 60
    scale = (W * H) / top.sum()
    sizes = [v * scale for v in top.values]
    rects = _squarify(sizes, 0, 0, W, H)

    cmap = plt.cm.tab20.colors
    fig, ax = plt.subplots(figsize=(12, 7.5))
    for i, (rect, (cat, val)) in enumerate(zip(rects, top.items())):
        color = "#CCCCCC" if cat.startswith("Other reasons") else cmap[i % len(cmap)]
        ax.add_patch(Rectangle((rect["x"], rect["y"]), rect["dx"], rect["dy"],
                                facecolor=color, edgecolor="white", linewidth=1.5))
        pct = val / total_all * 100
        area = rect["dx"] * rect["dy"]
        if area > 12:
            label = wrap_label(cat, width=max(10, int(rect["dx"] * 1.6)))
            fontsize = 9 if area > 60 else 7.5
            ax.text(rect["x"] + rect["dx"] / 2, rect["y"] + rect["dy"] / 2,
                    f"{label}\n{val} ({pct:.1f}%)", ha="center", va="center",
                    fontsize=fontsize, color="black" if area < 200 else "white", wrap=True)

    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis("off")
    ax.set_title(f"Reasons Farmers Are Not Adopting a Practice: {title}\n"
                 "(box size = number of farmer-practice instances)", loc="left", fontsize=13)
    fig.text(0.01, 0.01, f"Data source: {data_source}", fontsize=8, color="dimgray")
    plt.tight_layout(rect=[0, 0.02, 1, 1])
    plt.savefig(outfile, dpi=150, bbox_inches="tight")
    plt.close()
