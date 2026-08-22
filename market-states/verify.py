"""
Verification: prints for human eyeballing, then asserts what must be true.

The printed sections are for judgement -- a bar count that looks off, a
synthetic percentage that jumps on one ticker, a state distribution with a
suspicious spike. The assertions at the end are for things that are not a
matter of judgement: if one fails, the data layer is wrong and nothing built
on top of it can be trusted.
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path

import pandas as pd

import config
import sessions as sessions_mod

INDICATOR_COLUMNS = ["ema_fast", "ema_slow", "session_vwap", "volume_zscore"]


def _rule(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def report_sessions(df: pd.DataFrame) -> None:
    _rule("SESSIONS")

    for ticker, group in df.groupby("ticker", sort=True):
        per_session = group.groupby("session_date").agg(
            bars=("timestamp", "size"),
            expected=("expected_bars", "first"),
        )
        print(f"\n{ticker}")
        print(f"  sessions:      {len(per_session)}")
        print(f"  date range:    {group['session_date'].min()} .. {group['session_date'].max()}")
        print(
            f"  bars/session:  min={per_session['bars'].min()}  "
            f"median={per_session['bars'].median():.0f}  max={per_session['bars'].max()}"
        )

        mismatched = per_session[per_session["bars"] != per_session["expected"]]
        if len(mismatched):
            print(f"  !! {len(mismatched)} session(s) with an unexpected bar count:")
            for session_date, row in mismatched.iterrows():
                print(f"       {session_date}: {row['bars']} bars, expected {row['expected']}")
        else:
            print("  bar counts:    all sessions match their expected length")

        # Half days are worth calling out explicitly: they are the case most
        # likely to be silently mishandled, so say whether any are present.
        half_days = per_session[per_session["expected"] != 390]
        if len(half_days):
            print(f"  early closes:  {len(half_days)} session(s)")
            for session_date, row in half_days.iterrows():
                print(f"       {session_date}: {row['expected']} bars expected, {row['bars']} present")
        else:
            print("  early closes:  none in this window")


def report_synthetic(df: pd.DataFrame) -> None:
    _rule("SYNTHETIC (GAP-FILLED) BARS")

    for ticker, group in df.groupby("ticker", sort=True):
        count = int(group["is_synthetic"].sum())
        pct = count / len(group) * 100
        print(f"\n{ticker}: {count:,} of {len(group):,} bars ({pct:.3f}%)")

        if count:
            by_session = (
                group[group["is_synthetic"]].groupby("session_date").size().sort_values(ascending=False)
            )
            print(f"  worst sessions: ")
            for session_date, n in by_session.head(5).items():
                print(f"       {session_date}: {n} synthetic bar(s)")

            by_minute = (
                group[group["is_synthetic"]].groupby("minute_of_day").size().sort_values(ascending=False)
            )
            print(f"  most-affected minutes: {', '.join(f'{m} ({n})' for m, n in by_minute.head(5).items())}")


def report_warmup(df: pd.DataFrame) -> None:
    _rule("WARMUP")

    for ticker, group in df.groupby("ticker", sort=True):
        warm = group[group["warmup"]]
        live = group[~group["warmup"]]
        print(f"\n{ticker}")
        print(f"  warmup bars:   {len(warm):,} ({len(warm) / len(group) * 100:.1f}%)")
        print(f"  emitted bars:  {len(live):,}")
        if len(warm):
            print(f"  warmup spans:  {warm['session_date'].min()} .. {warm['session_date'].max()}")
        if len(live):
            print(f"  output spans:  {live['session_date'].min()} .. {live['session_date'].max()}")

            # The volume z-score leaves warmup independently for each
            # minute-of-day bucket, so sessions right at the warmup boundary
            # can be emitted with only some of their bars. Worth surfacing:
            # a partially emitted session slightly over-represents whichever
            # time-of-day buckets it did emit. Expect one or two at the
            # boundary; a large number means something is wrong upstream.
            emitted = live.groupby("session_date").size()
            expected = live.groupby("session_date")["expected_bars"].first()
            partial = emitted[emitted != expected.reindex(emitted.index)]
            if len(partial):
                print(f"  partial sessions: {len(partial)} at the warmup boundary")
                for session_date, n in partial.items():
                    print(f"       {session_date}: {n} of {int(expected[session_date])} bars emitted")
            else:
                print("  partial sessions: none")


def dump_random_session(df: pd.DataFrame, output_dir: Path, seed: int | None = None) -> Path:
    """Write one full randomly chosen session to CSV, every column included."""
    _rule("RANDOM SESSION DUMP")

    rng = random.Random(seed)
    ticker = rng.choice(sorted(df["ticker"].unique()))
    ticker_rows = df[df["ticker"] == ticker]
    session_date = rng.choice(sorted(ticker_rows["session_date"].unique()))

    session_rows = ticker_rows[ticker_rows["session_date"] == session_date].copy()
    session_rows = session_rows.sort_values("timestamp")

    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"session_dump_{ticker}_{session_date}.csv"
    session_rows.to_csv(path, index=False)

    print(f"\n  ticker:  {ticker}")
    print(f"  session: {session_date}")
    print(f"  bars:    {len(session_rows)}")
    print(f"  written: {path}")
    print(f"\n  first 3 and last 3 bars:")

    preview_columns = [
        c for c in [
            "timestamp", "close", "ema_fast", "ema_slow", "session_vwap",
            "volume", "volume_zscore", "is_synthetic", "state_id", "name",
        ] if c in session_rows.columns
    ]
    with pd.option_context("display.width", 220, "display.max_columns", 30):
        print(session_rows[preview_columns].head(3).to_string(index=False))
        print("    ...")
        print(session_rows[preview_columns].tail(3).to_string(index=False))

    return path


def report_state_distribution(encoded: pd.DataFrame, top: int = 20) -> None:
    _rule("STATE FREQUENCY DISTRIBUTION")

    counts = encoded.groupby(["state_id", "name"]).size().sort_values(ascending=False)
    total = counts.sum()
    observed = len(counts)

    print(f"\n  {observed} of 120 possible states observed, {total:,} bars encoded\n")
    print(f"  {'id':>4}  {'count':>8}  {'pct':>6}  name")
    for (state_id, name), count in counts.head(top).items():
        print(f"  {state_id:>4}  {count:>8,}  {count / total * 100:>5.2f}%  {name}")

    if observed > top:
        print(f"  ... {observed - top} more observed states (full list in states.csv)")

    unobserved = 120 - observed
    if unobserved:
        print(f"\n  {unobserved} state(s) never observed -- listed with count 0 in states.csv")


def run_assertions(df: pd.DataFrame, encoded: pd.DataFrame) -> list[str]:
    """Every check that is not a matter of judgement. Returns failure messages."""
    _rule("ASSERTIONS")
    failures: list[str] = []

    def check(label: str, ok: bool, detail: str = "") -> None:
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {label}" + (f"  -- {detail}" if detail and not ok else ""))
        if not ok:
            failures.append(f"{label}: {detail}")

    # 1. Timestamps strictly monotonic within ticker.
    for ticker, group in df.groupby("ticker", sort=True):
        ordered = group.sort_values("timestamp")
        strictly_increasing = ordered["timestamp"].is_monotonic_increasing and not ordered["timestamp"].duplicated().any()
        check(
            f"timestamps strictly monotonic within {ticker}",
            strictly_increasing,
            "found non-increasing or repeated timestamps",
        )

    # 2. No duplicate timestamps within a ticker.
    duplicates = df.duplicated(subset=["ticker", "timestamp"]).sum()
    check("no duplicate (ticker, timestamp) pairs", duplicates == 0, f"{duplicates} duplicates")

    # 3. No NaN in any indicator column post-warmup.
    post_warmup = df[~df["warmup"]]
    for column in INDICATOR_COLUMNS:
        nan_count = int(post_warmup[column].isna().sum())
        check(f"no NaN in {column} post-warmup", nan_count == 0, f"{nan_count} NaN values")

    # 4. Session VWAP within that session's running high/low range.
    #    Running, not whole-session: VWAP at 10:00 must sit inside the range
    #    seen up to 10:00, which is the stronger and more useful claim.
    grouped = df.sort_values(["ticker", "timestamp"]).groupby(["ticker", "session_date"], sort=False)
    running_high = grouped["high"].cummax()
    running_low = grouped["low"].cummin()
    ordered = df.sort_values(["ticker", "timestamp"])
    tolerance = 1e-6
    outside = (
        (ordered["session_vwap"] > running_high + tolerance)
        | (ordered["session_vwap"] < running_low - tolerance)
    )
    outside_count = int(outside.sum())
    check(
        "session VWAP within running session high/low",
        outside_count == 0,
        f"{outside_count} bars outside range",
    )

    # 5. No bars outside regular trading hours.
    schedule = sessions_mod.get_sessions(
        pd.Timestamp(df["session_date"].min()).date(),
        pd.Timestamp(df["session_date"].max()).date(),
    ).set_index("session_date")

    joined = df.join(schedule[["market_open", "market_close"]], on="session_date")
    outside_rth = (
        (joined["timestamp"] < joined["market_open"])
        | (joined["timestamp"] >= joined["market_close"])
    )
    outside_rth_count = int(outside_rth.sum())
    check("no bars outside RTH", outside_rth_count == 0, f"{outside_rth_count} bars outside session bounds")

    # 6. Every session date in the data is a real NYSE trading day.
    unexpected_dates = set(df["session_date"].unique()) - set(schedule.index)
    check(
        "all session dates are NYSE trading days",
        not unexpected_dates,
        f"{len(unexpected_dates)} non-trading dates: {sorted(unexpected_dates)[:5]}",
    )

    # 7. Encoded output carries a valid state for every emitted bar.
    if len(encoded):
        invalid_ids = int(((encoded["state_id"] < 0) | (encoded["state_id"] > 119)).sum())
        check("all state_ids in range 0..119", invalid_ids == 0, f"{invalid_ids} out of range")

        missing_states = int(encoded["state_id"].isna().sum())
        check("no bar left unencoded", missing_states == 0, f"{missing_states} bars with no state")

        check(
            "encoded row count matches post-warmup bar count",
            len(encoded) == len(post_warmup),
            f"{len(encoded)} encoded vs {len(post_warmup)} post-warmup",
        )

    # 8. Synthetic bars carry zero volume, real bars are not silently zeroed.
    bad_synthetic = int((df["is_synthetic"] & (df["volume"] != 0)).sum())
    check("all synthetic bars have volume 0", bad_synthetic == 0, f"{bad_synthetic} violations")

    return failures


def verify(processed_path: Path, encoded_path: Path, output_dir: Path, seed: int | None = None) -> int:
    df = pd.read_parquet(processed_path)
    encoded = pd.read_parquet(encoded_path)

    print(f"\nloaded {len(df):,} processed bars from {processed_path}")
    print(f"loaded {len(encoded):,} encoded bars from {encoded_path}")

    report_sessions(df)
    report_synthetic(df)
    report_warmup(df)
    report_state_distribution(encoded)
    dump_random_session(encoded, output_dir, seed=seed)

    failures = run_assertions(df, encoded)

    _rule("RESULT")
    if failures:
        print(f"\n  {len(failures)} ASSERTION(S) FAILED:\n")
        for failure in failures:
            print(f"    - {failure}")
        return 1

    print("\n  all assertions passed\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the market-states data layer.")
    parser.add_argument("--processed", type=Path, default=config.PROCESSED_DIR / "bars.parquet")
    parser.add_argument("--encoded", type=Path, default=config.PROCESSED_DIR / "encoded.parquet")
    parser.add_argument("--output-dir", type=Path, default=config.OUTPUT_DIR)
    parser.add_argument("--seed", type=int, default=None, help="seed the random session choice")
    args = parser.parse_args()

    return verify(args.processed, args.encoded, args.output_dir, args.seed)


if __name__ == "__main__":
    raise SystemExit(main())
