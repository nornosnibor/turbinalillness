"""
DEVELOPMENT ONLY -- tests for the two forward-compatibility claims that the
rest of the system is built on. Both are claims a comment cannot prove.

    python dev/test_encoder.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402
import states as states_mod  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  -- {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(label)


def test_live_and_batch_agree(encoded: pd.DataFrame) -> None:
    """The claim: a live caller passing a long window gets the same state as
    batch encoding, which passes a single row.

    This is THE invariant of the design. If it ever fails, the live agent will
    silently disagree with the map it was built from.
    """
    print("\nlive window vs batch single-row:")

    sample = encoded.sample(n=min(500, len(encoded)), random_state=1).sort_values("timestamp")
    disagreements = 0

    for position in sample.index:
        row_number = encoded.index.get_loc(position)

        # A live agent would hold a rolling buffer -- simulate 200 bars of it.
        window_start = max(0, row_number - 199)
        live_window = encoded.iloc[window_start:row_number + 1]
        single_row = encoded.iloc[row_number:row_number + 1]

        live_state = states_mod.encode_state(live_window)
        batch_state = states_mod.encode_state(single_row)

        if live_state != batch_state:
            disagreements += 1

        # And both must match what the pipeline already wrote out.
        if live_state.state_id != encoded.iloc[row_number]["state_id"]:
            disagreements += 1

    check(
        f"{len(sample)} bars encode identically from a 200-bar window and a 1-bar window",
        disagreements == 0,
        f"{disagreements} disagreements",
    )


def test_appending_a_dimension_preserves_ids() -> None:
    """The claim: adding a 6th dimension does not renumber existing states.

    Simulated by appending a dimension and recomputing every existing state's
    id with the new dimension at its first value.
    """
    print("\nappending a new dimension:")

    original = {state_id: states_mod.decode_state_id(state_id) for state_id in range(states_mod.TOTAL_STATES)}

    saved_dimensions = list(states_mod.DIMENSIONS)
    saved_multipliers = list(states_mod.MULTIPLIERS)
    saved_total = states_mod.TOTAL_STATES

    try:
        # Append, exactly as the comment in states.py instructs.
        states_mod.DIMENSIONS.append(("spread_regime", ["tight", "wide"]))
        states_mod.MULTIPLIERS = states_mod._multipliers()
        states_mod.TOTAL_STATES = saved_total * 2

        renumbered = 0
        for state_id, values in original.items():
            extended = dict(values, spread_regime="tight")  # index 0 of the new dimension
            if states_mod.compute_state_id(extended) != state_id:
                renumbered += 1

        check("all 120 existing state_ids unchanged", renumbered == 0, f"{renumbered} renumbered")
        check("state space doubled to 240", states_mod.TOTAL_STATES == 240)

        # The new dimension's second value must occupy fresh ids, not collide.
        new_ids = {
            states_mod.compute_state_id(dict(values, spread_regime="wide"))
            for values in original.values()
        }
        check("new dimension's second value gets fresh ids", min(new_ids) >= saved_total)
    finally:
        states_mod.DIMENSIONS[:] = saved_dimensions
        states_mod.MULTIPLIERS = saved_multipliers
        states_mod.TOTAL_STATES = saved_total


def test_bucket_boundaries() -> None:
    """Thresholds must behave exactly as documented, including at the edges."""
    print("\nbucket boundaries:")

    low_max = states_mod.STATE_CONFIG["VOLUME_LOW_MAX"]
    high_min = states_mod.STATE_CONFIG["VOLUME_HIGH_MIN"]

    cases = [
        (low_max - 0.001, "low"),
        (low_max, "normal"),          # boundary is exclusive on the low side
        (0.0, "normal"),
        (high_min, "normal"),         # and exclusive on the high side
        (high_min + 0.001, "high"),
    ]
    wrong = [(z, expected, states_mod.classify_volume(z)) for z, expected in cases
             if states_mod.classify_volume(z) != expected]
    check("volume buckets correct at and around both thresholds", not wrong, str(wrong))


def test_half_day_time_buckets() -> None:
    """On a 210-bar half day, close30 must be the last 30 minutes (12:30-13:00),
    not 15:30-16:00, and no bar may be labelled afternoon."""
    print("\nhalf-day time buckets:")

    half_day_open = pd.Timestamp("2025-11-28 09:30", tz=config.MARKET_TZ)
    labels = []
    for minute in range(210):
        timestamp = half_day_open + pd.Timedelta(minutes=minute)
        labels.append(states_mod.classify_time_of_day(timestamp, minute, 210 - minute))

    close30 = [i for i, label in enumerate(labels) if label == "close30"]
    check("close30 covers exactly the final 30 bars", close30 == list(range(180, 210)),
          f"got bars {close30[:3]}..{close30[-3:] if close30 else []}")
    check("open30 covers exactly the first 30 bars",
          [i for i, label in enumerate(labels) if label == "open30"] == list(range(30)))
    check("no 'afternoon' bar on a 13:00 close", "afternoon" not in labels,
          f"{labels.count('afternoon')} afternoon bars")

    # And a normal day must still put close30 at 15:30-15:59.
    full_open = pd.Timestamp("2025-11-26 09:30", tz=config.MARKET_TZ)
    full_labels = [
        states_mod.classify_time_of_day(full_open + pd.Timedelta(minutes=m), m, 390 - m)
        for m in range(390)
    ]
    first_close30 = full_labels.index("close30")
    check("normal day close30 starts at 15:30",
          (full_open + pd.Timedelta(minutes=first_close30)).strftime("%H:%M") == "15:30",
          (full_open + pd.Timedelta(minutes=first_close30)).strftime("%H:%M"))
    check("normal day has afternoon bars", "afternoon" in full_labels)


def test_warmup_bars_are_rejected() -> None:
    """encode_state must refuse a bar with a NaN indicator rather than guess."""
    print("\nwarmup rejection:")

    bar = pd.DataFrame([{
        "timestamp": pd.Timestamp("2025-09-19 10:15", tz=config.MARKET_TZ),
        "close": 100.0, "ema_fast": 99.0, "ema_slow": 98.0,
        "session_vwap": 99.5, "volume_zscore": float("nan"),
        "minutes_from_open": 45, "minutes_to_close": 345,
    }])
    try:
        states_mod.encode_state(bar)
        check("NaN z-score raises rather than encoding", False, "no exception raised")
    except ValueError:
        check("NaN z-score raises rather than encoding", True)

    try:
        states_mod.encode_state(pd.DataFrame())
        check("empty window raises", False, "no exception raised")
    except ValueError:
        check("empty window raises", True)


def main() -> int:
    encoded_path = config.PROCESSED_DIR / "encoded.parquet"
    if not encoded_path.exists():
        raise SystemExit(f"no encoded data at {encoded_path} -- run run.py first")

    encoded = pd.read_parquet(encoded_path).sort_values(["ticker", "timestamp"]).reset_index(drop=True)
    print(f"loaded {len(encoded):,} encoded bars")

    test_live_and_batch_agree(encoded)
    test_appending_a_dimension_preserves_ids()
    test_bucket_boundaries()
    test_half_day_time_buckets()
    test_warmup_bars_are_rejected()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} TEST(S) FAILED: {FAILURES}")
        return 1
    print("all tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
