"""
Timezone conversion, NYSE session boundaries, RTH filtering, and grid reindex.

This is where the subtle bugs live, so a few invariants are stated once here
and enforced below:

  * Polygon timestamps are millisecond epochs in UTC. We convert to
    America/New_York and keep them tz-aware for the rest of the pipeline.
    Nothing downstream ever sees a naive timestamp or a UTC one.

  * Bars are labelled by their START time. A 390-minute session running
    09:30-16:00 therefore has bars 09:30 .. 15:59 inclusive -- the last bar
    starts at 15:59, and a bar labelled 16:00 belongs to no session.

  * Session boundaries come from the NYSE calendar per date, never from
    hardcoded times. Early closes (13:00 ET) and the DST changeover are then
    handled by construction rather than by special case.
"""

from __future__ import annotations

from datetime import date

import pandas as pd
import pandas_market_calendars as mcal

import config

# Price columns that get forward-filled when a bar is missing.
PRICE_COLUMNS = ["open", "high", "low", "close"]


def get_sessions(start: date, end: date) -> pd.DataFrame:
    """Return the true NYSE session boundaries for each trading date in range.

    Columns: session_date, market_open, market_close, expected_bars.
    Times are tz-aware in America/New_York, so a session that falls on the
    other side of the DST switch simply carries a different UTC offset and
    needs no special handling.
    """
    calendar = mcal.get_calendar(config.CALENDAR_NAME)
    schedule = calendar.schedule(
        start_date=start.isoformat(),
        end_date=end.isoformat(),
        tz=config.MARKET_TZ,
    )

    sessions = pd.DataFrame(
        {
            "session_date": schedule.index.date,
            "market_open": schedule["market_open"].values,
            "market_close": schedule["market_close"].values,
        }
    )
    sessions["market_open"] = pd.to_datetime(sessions["market_open"], utc=True).dt.tz_convert(config.MARKET_TZ)
    sessions["market_close"] = pd.to_datetime(sessions["market_close"], utc=True).dt.tz_convert(config.MARKET_TZ)

    # Bars are labelled by start time, so a session spanning [open, close)
    # contains exactly this many one-minute bars. On a half day this is 210,
    # not 390 -- which is precisely why it is derived, not assumed.
    delta_minutes = (sessions["market_close"] - sessions["market_open"]).dt.total_seconds() // 60
    sessions["expected_bars"] = delta_minutes.astype(int)

    return sessions.reset_index(drop=True)


def to_eastern(raw: pd.DataFrame) -> pd.DataFrame:
    """Convert Polygon's UTC millisecond epochs to tz-aware Eastern timestamps."""
    out = raw.copy()
    out["timestamp"] = (
        pd.to_datetime(out["timestamp_ms"], unit="ms", utc=True)
        .dt.tz_convert(config.MARKET_TZ)
    )
    return out


def session_grid(market_open: pd.Timestamp, market_close: pd.Timestamp) -> pd.DatetimeIndex:
    """The complete expected minute grid for one session.

    Half-open interval [open, close): the bar labelled 15:59 is the last one,
    and 16:00 is excluded because a bar starting at the close does not exist.
    """
    return pd.date_range(
        start=market_open,
        end=market_close - pd.Timedelta(minutes=1),
        freq="min",
        tz=market_open.tz,
    )


def build_rth_frame(raw: pd.DataFrame, sessions: pd.DataFrame) -> pd.DataFrame:
    """Filter raw bars to regular trading hours and reindex onto the full grid.

    Two failure modes this guards against:

    1. Pre/post-market leakage. Polygon aggregates include 04:00-09:30 and
       16:00-20:00 bars. If those reach the session VWAP the anchor is wrong
       and every VWAP-derived feature is quietly wrong with it, so they are
       dropped here, before any indicator runs.

    2. Silent gaps. Polygon emits no bar at all when no qualifying trade
       occurred in a minute. Dropping those would leave holes that make the
       EMA span more wall-clock time than it appears to; interpolating them
       silently would invent trading that did not happen. Instead every
       missing bar is inserted explicitly, flagged is_synthetic=True, given
       volume 0, and priced at the previous close. The flag survives all the
       way into the final output so later analysis can exclude them.
    """
    eastern = to_eastern(raw)

    frames: list[pd.DataFrame] = []
    dropped_leading = 0

    for session in sessions.itertuples(index=False):
        grid = session_grid(session.market_open, session.market_close)

        # Filter to this session's RTH window. Comparing tz-aware timestamps
        # means the DST changeover needs no special case: the offsets differ
        # but the instants compare correctly.
        mask = (eastern["timestamp"] >= session.market_open) & (
            eastern["timestamp"] < session.market_close
        )
        bars = eastern.loc[mask].copy()

        if bars.empty:
            # A scheduled session with no data at all is a fetch problem, not
            # something to paper over with 390 synthetic bars.
            continue

        bars = bars.drop_duplicates(subset=["timestamp"], keep="first")
        bars = bars.set_index("timestamp").reindex(grid)

        # A row is synthetic exactly when the reindex had nothing to put there.
        # Volume is the tell: a real bar always has a volume value, even if the
        # price columns happen to repeat.
        bars["is_synthetic"] = bars["volume"].isna()

        bars["session_date"] = session.session_date
        bars["expected_bars"] = session.expected_bars

        # Position within the session, derived from the grid rather than from
        # the clock. On a half day minutes_to_close counts down to 13:00, so
        # "last 30 minutes of the session" means the same thing on every date.
        bars["minutes_from_open"] = range(len(grid))
        bars["minutes_to_close"] = session.expected_bars - pd.Series(
            range(len(grid)), index=grid
        )

        frames.append(bars)

    if not frames:
        raise ValueError("no sessions produced any bars -- check the raw cache")

    combined = pd.concat(frames)
    combined.index.name = "timestamp"
    combined = combined.reset_index()

    # Forward-fill prices across the whole ticker series, in order, so a gap at
    # a session open inherits the previous session's closing price rather than
    # being left empty. Filling within a session only would leave the first bar
    # of a session unfillable.
    combined = combined.sort_values("timestamp").reset_index(drop=True)
    combined["close"] = combined["close"].ffill()

    # For a synthetic bar there was no trading, so OHLC all collapse to the
    # carried-forward close. Doing this explicitly (rather than ffilling each
    # column independently) keeps high >= low >= 0 and prevents a stale high
    # from a real bar leaking into a synthetic one.
    synthetic = combined["is_synthetic"]
    for column in ["open", "high", "low"]:
        combined.loc[synthetic, column] = combined.loc[synthetic, "close"]
        combined[column] = combined[column].ffill()

    combined.loc[synthetic, "volume"] = 0.0
    combined.loc[synthetic, "transactions"] = 0.0

    # Any row still missing a close is at the very start of the dataset, with no
    # prior bar to carry forward from. Back-filling would be look-ahead, so we
    # drop them and say so.
    unfillable = combined["close"].isna()
    if unfillable.any():
        dropped_leading = int(unfillable.sum())
        print(
            f"  dropped {dropped_leading} leading bar(s) with no prior close to "
            f"forward-fill from (start of dataset)"
        )
        combined = combined.loc[~unfillable].reset_index(drop=True)

    combined["ticker"] = raw["ticker"].iloc[0] if "ticker" in raw.columns else None
    combined["is_synthetic"] = combined["is_synthetic"].astype(bool)
    combined["volume"] = combined["volume"].astype(float)

    # minute_of_day is the key the volume z-score is computed against, and it
    # is stored as a string ("09:31") rather than an offset from the open so
    # that a half day's 13:00 bars are compared against 13:00 bars on full
    # days, not against whatever happened 210 minutes after some other open.
    combined["minute_of_day"] = combined["timestamp"].dt.strftime("%H:%M")

    keep = [
        "ticker", "timestamp", "session_date", "minute_of_day",
        "minutes_from_open", "minutes_to_close",
        "open", "high", "low", "close", "volume", "transactions",
        "is_synthetic", "expected_bars",
    ]
    return combined[[c for c in keep if c in combined.columns]]
