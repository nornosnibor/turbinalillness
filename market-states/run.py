"""
Pipeline orchestration.

Stages run in dependency order and each writes its output to disk, so any stage
can be inspected before the next one depends on it:

    fetch    -> data/raw/<TICKER>/<TICKER>-<YYYY-MM>.parquet   (immutable)
    process  -> data/processed/bars.parquet                    (clean + enriched)
    encode   -> data/processed/encoded.parquet                 (post-warmup + states)
               data/output/states.csv                          (the state map)

Usage:
    python run.py                                  # 6 months ending yesterday
    python run.py --tickers SPY --start 2026-06-01 --end 2026-08-21
    python run.py --skip-fetch                     # process what is already cached
"""

from __future__ import annotations

import argparse
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

import config
import fetch
import indicators
import sessions as sessions_mod
import states as states_mod


def default_window(months: int = 6) -> tuple[date, date]:
    """6 months ending yesterday.

    Yesterday rather than today because today's session may be in progress or
    not yet aggregated, and a partial final session would produce a session
    whose bar count does not match its expected length.
    """
    end = date.today() - timedelta(days=1)
    # Approximate a 6-month step by calendar arithmetic on the month number.
    month_index = end.month - months
    year = end.year + (month_index - 1) // 12
    month = (month_index - 1) % 12 + 1
    day = min(end.day, 28)  # 28 is safe in every month
    return date(year, month, day), end


def process(tickers: list[str], start: date, end: date, raw_paths: dict[str, list[Path]]) -> pd.DataFrame:
    """Clean and enrich raw bars for every ticker into one frame."""
    schedule = sessions_mod.get_sessions(start, end)
    print(f"\nNYSE calendar: {len(schedule)} session(s) in {start} .. {end}")
    early = schedule[schedule["expected_bars"] != 390]
    if len(early):
        print(f"  including {len(early)} early close(s): {list(early['session_date'])}")

    frames = []
    for ticker in tickers:
        print(f"\n{ticker}: cleaning")
        raw = fetch.load_raw(ticker, raw_paths[ticker])
        if raw.empty:
            print(f"  no raw data for {ticker}, skipping")
            continue
        print(f"  raw bars (all hours):  {len(raw):,}")

        clean = sessions_mod.build_rth_frame(raw, schedule)
        print(f"  RTH bars (gridded):    {len(clean):,}")
        print(f"  synthetic bars:        {int(clean['is_synthetic'].sum()):,}")
        frames.append(clean)

    if not frames:
        raise SystemExit("no data to process -- run the fetch stage first")

    combined = pd.concat(frames, ignore_index=True)

    print(f"\nindicators: EMA {config.EMA_FAST_SPAN}/{config.EMA_SLOW_SPAN} "
          f"(reset_daily={config.EMA_RESET_DAILY}), session VWAP, "
          f"volume z-score over {config.Z_WINDOW_SESSIONS} prior sessions")
    enriched = indicators.build_indicators(combined)

    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    output_path = config.PROCESSED_DIR / "bars.parquet"
    enriched.to_parquet(output_path, index=False)
    print(f"  wrote {len(enriched):,} bars -> {output_path}")

    return enriched


def encode(enriched: pd.DataFrame) -> pd.DataFrame:
    """Encode post-warmup bars and write the state dictionary."""
    print(f"\nencoding states (one call to encode_state per bar)")
    encoded = states_mod.encode_batch(enriched)
    print(f"  encoded {len(encoded):,} of {len(enriched):,} bars "
          f"({int(enriched['warmup'].sum()):,} excluded as warmup)")

    encoded_path = config.PROCESSED_DIR / "encoded.parquet"
    encoded.to_parquet(encoded_path, index=False)
    print(f"  wrote {encoded_path}")

    dictionary = states_mod.build_state_dictionary(encoded)
    config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    states_path = config.OUTPUT_DIR / "states.csv"
    dictionary.to_csv(states_path, index=False)
    observed = int((dictionary["bar_count"] > 0).sum())
    print(f"  wrote {states_path} ({observed} of {len(dictionary)} states observed)")

    return encoded


def main() -> int:
    default_start, default_end = default_window()

    parser = argparse.ArgumentParser(description="Build the SPY/QQQ minute-bar state layer.")
    parser.add_argument("--tickers", nargs="+", default=config.TICKERS)
    parser.add_argument("--start", type=date.fromisoformat, default=default_start)
    parser.add_argument("--end", type=date.fromisoformat, default=default_end)
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        help="process only what is already in the raw cache (no API key needed)",
    )
    args = parser.parse_args()

    print(f"tickers: {', '.join(args.tickers)}")
    print(f"window:  {args.start} .. {args.end}")

    if args.skip_fetch:
        print("\nfetch: skipped, using raw cache only")
        raw_paths = {
            ticker: sorted((config.RAW_DIR / ticker).glob(f"{ticker}-*.parquet"))
            for ticker in args.tickers
        }
        for ticker, paths in raw_paths.items():
            print(f"  {ticker}: {len(paths)} cached month file(s)")
    else:
        raw_paths = fetch.fetch_and_cache(args.tickers, args.start, args.end)

    enriched = process(args.tickers, args.start, args.end, raw_paths)
    encode(enriched)

    print("\ndone. run `python verify.py` to check the result.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
