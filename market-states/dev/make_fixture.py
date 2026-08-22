"""
DEVELOPMENT ONLY -- generates synthetic Polygon-shaped raw bars.

This is NOT part of the pipeline and never runs during a real build. It exists
because two important code paths cannot be exercised by the live data:

  * Early closes. The 6-month window ending 2026-08-21 contains none -- July 3
    2026 is a full closure, not a half day. Without a fixture, the half-day
    handling in sessions.py would ship untested.
  * Missing bars. SPY and QQQ are liquid enough that gaps are rare, so the
    synthetic-bar path needs a deliberately gappy dataset to prove out.

The fixture window (2025-08-01 .. 2026-01-31) is chosen to contain the DST
changeover (2025-11-02), Black Friday (2025-11-28, 13:00 close) and Christmas
Eve (2025-12-24, 13:00 close).

Output is written in exactly Polygon's aggregates schema -- UTC millisecond
epochs, pre/post market bars included -- so it enters the pipeline through the
same door as real data.

    MARKET_STATES_DATA_DIR=data_fixture python dev/make_fixture.py
"""

from __future__ import annotations

import json
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pandas_market_calendars as mcal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402
import fetch  # noqa: E402

FIXTURE_START = date(2025, 8, 1)
FIXTURE_END = date(2026, 1, 31)

# Probability that a given minute produces no bar at all. Deliberately much
# higher than reality (SPY is nearly gapless) so the synthetic-bar path gets
# meaningful coverage. Midday minutes are made likelier to be missing than the
# open or close, mirroring real illiquidity.
BASE_MISSING_RATE = 0.004

TICKER_SEEDS = {"SPY": 20260101, "QQQ": 20260202}
TICKER_START_PRICE = {"SPY": 560.0, "QQQ": 480.0}


def volume_shape(minutes_from_open: int, session_length: int) -> float:
    """U-shaped intraday volume curve: heavy at both ends, light midday."""
    position = minutes_from_open / max(session_length - 1, 1)
    # Sum of two decaying humps at the open and the close, plus a floor.
    open_hump = np.exp(-position / 0.12)
    close_hump = np.exp(-(1 - position) / 0.10)
    return 0.35 + 1.9 * open_hump + 1.3 * close_hump


def build_ticker(ticker: str) -> pd.DataFrame:
    rng = np.random.default_rng(TICKER_SEEDS[ticker])
    chooser = random.Random(TICKER_SEEDS[ticker])

    calendar = mcal.get_calendar(config.CALENDAR_NAME)
    schedule = calendar.schedule(
        start_date=FIXTURE_START.isoformat(),
        end_date=FIXTURE_END.isoformat(),
        tz=config.MARKET_TZ,
    )

    price = TICKER_START_PRICE[ticker]
    rows = []

    for session_ts, session in schedule.iterrows():
        market_open = session["market_open"]
        market_close = session["market_close"]
        session_length = int((market_close - market_open).total_seconds() // 60)

        # Pre-market 04:00 -> open, RTH open -> close, post-market close -> 20:00.
        # Pre/post bars exist so the RTH filter has something to actually filter.
        premarket = pd.date_range(
            market_open.normalize() + pd.Timedelta(hours=4),
            market_open - pd.Timedelta(minutes=1),
            freq="min",
        )
        regular = pd.date_range(
            market_open, market_close - pd.Timedelta(minutes=1), freq="min"
        )
        postmarket = pd.date_range(
            market_close,
            market_close.normalize() + pd.Timedelta(hours=20) - pd.Timedelta(minutes=1),
            freq="min",
        )

        for phase, grid in (("pre", premarket), ("rth", regular), ("post", postmarket)):
            for offset, timestamp in enumerate(grid):
                # Overnight/inactive sessions drift less than RTH.
                volatility = 0.00035 if phase == "rth" else 0.00012
                price *= float(np.exp(rng.normal(0, volatility)))

                if phase == "rth":
                    shape = volume_shape(offset, session_length)
                    missing_rate = BASE_MISSING_RATE / max(shape, 0.2)
                else:
                    shape = 0.05
                    missing_rate = 0.35  # thin outside RTH

                if chooser.random() < missing_rate:
                    continue  # no qualifying trades this minute -> Polygon emits no bar

                spread = price * float(abs(rng.normal(0, 0.0004))) + 0.01
                open_price = price * float(np.exp(rng.normal(0, 0.0001)))
                close_price = price
                high = max(open_price, close_price) + spread
                low = min(open_price, close_price) - spread

                base_volume = 900_000 if ticker == "SPY" else 550_000
                volume = float(max(1, rng.gamma(shape=6.0, scale=base_volume * shape / 6.0)))

                rows.append(
                    {
                        "timestamp_ms": int(timestamp.tz_convert("UTC").timestamp() * 1000),
                        "open": round(open_price, 4),
                        "high": round(high, 4),
                        "low": round(low, 4),
                        "close": round(close_price, 4),
                        "volume": round(volume, 2),
                        "transactions": int(max(1, volume / 180)),
                        "vwap_polygon": round((high + low + close_price) / 3, 4),
                    }
                )

    return pd.DataFrame(rows)


def main() -> int:
    print(f"fixture window: {FIXTURE_START} .. {FIXTURE_END}")
    print(f"writing into:   {config.RAW_DIR}")

    for ticker in ["SPY", "QQQ"]:
        bars = build_ticker(ticker)
        print(f"\n{ticker}: {len(bars):,} synthetic raw bars (all hours)")

        for chunk in fetch.month_chunks(ticker, FIXTURE_START, FIXTURE_END):
            start_ms = int(pd.Timestamp(chunk.start, tz=config.MARKET_TZ).timestamp() * 1000)
            end_ms = int(
                (pd.Timestamp(chunk.end, tz=config.MARKET_TZ) + pd.Timedelta(days=1)).timestamp() * 1000
            )
            month_bars = bars[(bars["timestamp_ms"] >= start_ms) & (bars["timestamp_ms"] < end_ms)]

            chunk.parquet_path.parent.mkdir(parents=True, exist_ok=True)
            month_bars.to_parquet(chunk.parquet_path, index=False)
            chunk.meta_path.write_text(
                json.dumps(
                    {
                        "ticker": ticker,
                        "covered_start": chunk.start.isoformat(),
                        "covered_end": chunk.end.isoformat(),
                        "row_count": int(len(month_bars)),
                        "fetched_at_utc": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        "SYNTHETIC_FIXTURE": True,  # so this can never be mistaken for real data
                    },
                    indent=2,
                )
            )
            print(f"  {chunk.label}: {len(month_bars):,} bars -> {chunk.parquet_path.name}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
