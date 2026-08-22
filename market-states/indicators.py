"""
Indicators over the cleaned RTH series.

Every indicator here uses only data up to and including the current bar. No
centered windows, no full-series mean/std, no normalisation that has seen the
future. Where a value cannot be computed without look-ahead, it is left NaN and
the bar is marked warmup rather than filled in with something plausible.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

import config


def add_emas(df: pd.DataFrame, reset_daily: bool | None = None) -> pd.DataFrame:
    """Add ema_fast (9) and ema_slow (50) over the RTH-only series.

    With reset_daily False (the default), sessions are concatenated and the EMA
    carries across the overnight gap. That is what charting platforms display,
    so a state derived from it matches what a human sees on a chart. The
    alternative -- restarting each morning -- is a genuinely different
    indicator, so it lives behind a config flag rather than being hardcoded.

    adjust=False gives the recursive form (each bar weights the previous EMA by
    1-alpha), which is what trading platforms use. adjust=True would reweight
    the whole history at every bar and disagree with every chart.
    """
    if reset_daily is None:
        reset_daily = config.EMA_RESET_DAILY

    out = df.sort_values(["ticker", "timestamp"]).reset_index(drop=True)

    def ema(series: pd.Series, span: int) -> pd.Series:
        return series.ewm(span=span, adjust=False).mean()

    if reset_daily:
        group_keys = ["ticker", "session_date"]
    else:
        group_keys = ["ticker"]

    grouped = out.groupby(group_keys, sort=False)["close"]
    out["ema_fast"] = grouped.transform(lambda s: ema(s, config.EMA_FAST_SPAN))
    out["ema_slow"] = grouped.transform(lambda s: ema(s, config.EMA_SLOW_SPAN))

    return out


def add_session_vwap(df: pd.DataFrame) -> pd.DataFrame:
    """Add session-anchored VWAP, reset at each session open.

    Typical price (H+L+C)/3, cumulative sum(typical * volume) / sum(volume),
    restarted every session.

    Synthetic bars carry volume 0, so they contribute 0 to both the numerator
    and the denominator: the running VWAP simply holds flat across them, which
    is the correct behaviour and needs no special case. The one place it does
    need care is a session whose opening bars are all synthetic -- cumulative
    volume is then 0 and the ratio is 0/0. There we fall back to the typical
    price itself, which is what VWAP converges to at a session's first real
    trade anyway.
    """
    out = df.copy()
    out["typical_price"] = (out["high"] + out["low"] + out["close"]) / 3.0

    pv = out["typical_price"] * out["volume"]
    group = out.groupby(["ticker", "session_date"], sort=False)

    cum_pv = group.apply(lambda g: (g["typical_price"] * g["volume"]).cumsum(), include_groups=False)
    cum_pv = cum_pv.reset_index(level=[0, 1], drop=True).sort_index()
    cum_vol = group["volume"].cumsum()

    out["session_vwap"] = np.where(cum_vol > 0, cum_pv / cum_vol.replace(0, np.nan), out["typical_price"])
    out["session_cum_volume"] = cum_vol

    return out


def add_volume_zscore(
    df: pd.DataFrame,
    window_sessions: int | None = None,
    min_observations: int | None = None,
) -> pd.DataFrame:
    """Add a volume z-score computed per minute-of-day against prior sessions.

    Why not a plain z-score over all bars: intraday volume is strongly U-shaped.
    The 09:30 and 15:59 bars carry several times the volume of a midday bar
    every single day, so a whole-series z-score labels every open and close
    "high volume" and tells you nothing you did not already know from the clock.

    Instead each bar is scored against the same minute-of-day across the
    trailing window: the 10:15 bar is compared with other 10:15 bars. The
    question becomes "was this 10:15 busy *for a 10:15*", which is the question
    worth asking.

    Leakage control: the rolling statistics are shifted by one session, so a
    bar is never part of its own baseline and no information from the current
    session reaches its own score.

    Synthetic bars are excluded from the baseline statistics -- their volume is
    an artefact of our own gap filling, not a market observation. They still
    receive a score (a zero-volume bar is genuinely a very quiet one) and stay
    flagged for downstream exclusion.
    """
    if window_sessions is None:
        window_sessions = config.Z_WINDOW_SESSIONS
    if min_observations is None:
        min_observations = config.Z_MIN_OBSERVATIONS

    out = df.copy()

    # One row per (ticker, minute_of_day, session), so ordering by session_date
    # within a minute-of-day group makes "rolling over N rows" mean exactly
    # "rolling over N sessions".
    out = out.sort_values(["ticker", "minute_of_day", "session_date"]).reset_index(drop=True)

    stats_input = out["volume"].where(~out["is_synthetic"])
    grouped = stats_input.groupby([out["ticker"], out["minute_of_day"]], sort=False)

    # .shift(1) AFTER the rolling window is what excludes the current session.
    # Doing it the other way round would leave the current bar inside its own
    # mean and std.
    rolling_mean = grouped.transform(
        lambda s: s.rolling(window_sessions, min_periods=min_observations).mean().shift(1)
    )
    rolling_std = grouped.transform(
        lambda s: s.rolling(window_sessions, min_periods=min_observations).std(ddof=1).shift(1)
    )

    # A zero or missing std means the baseline is degenerate (every prior
    # sample identical, or too few samples). Dividing by it would produce inf,
    # so the score stays NaN and the bar stays in warmup.
    safe_std = rolling_std.where(rolling_std > 0)
    out["volume_zscore"] = (out["volume"] - rolling_mean) / safe_std

    out["volume_baseline_mean"] = rolling_mean
    out["volume_baseline_std"] = rolling_std

    return out.sort_values(["ticker", "timestamp"]).reset_index(drop=True)


def mark_warmup(df: pd.DataFrame) -> pd.DataFrame:
    """Flag bars whose indicators are not yet trustworthy.

    Two separate requirements, and a bar is in warmup until BOTH are satisfied:

      * the 50-bar EMA needs 50 bars of history before it reflects the market
        rather than its own seed value;
      * the volume z-score needs a full trailing window of prior sessions for
        this minute-of-day.

    The second is far stricter than the first (roughly a month of sessions
    versus 50 minutes), so in practice it sets the boundary. Emitting bars that
    satisfy only the first would mean shipping states whose volume dimension is
    a guess dressed up as a measurement.
    """
    out = df.sort_values(["ticker", "timestamp"]).reset_index(drop=True)

    bar_index = out.groupby("ticker", sort=False).cumcount()
    ema_warmup = bar_index < config.EMA_WARMUP_BARS
    zscore_warmup = out["volume_zscore"].isna()

    out["bar_index"] = bar_index
    out["warmup"] = (ema_warmup | zscore_warmup).astype(bool)

    return out


def build_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Run the full indicator stack in dependency order."""
    out = add_emas(df)
    out = add_session_vwap(out)
    out = add_volume_zscore(out)
    out = mark_warmup(out)
    return out
