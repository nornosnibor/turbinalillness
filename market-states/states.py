"""
Discrete state encoding.

The contract that matters most in this file: encode_state is a pure function
over a window of bars, returning the state of the LAST bar in that window.
Historical encoding is that same function applied across the dataset -- there
is deliberately no separate vectorised implementation.

The reason is not tidiness. A live agent evaluating SPY each minute will call
encode_state on its current window. If batch encoding had its own fast path,
the two could drift apart, and the live system would silently disagree with the
map it was built from. That class of bug does not announce itself; it just
makes the map wrong in a way nobody notices. One function, both callers.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import pandas as pd

# ---------------------------------------------------------------------------
# The one place thresholds and boundaries live. No magic numbers below this.
# ---------------------------------------------------------------------------

STATE_CONFIG = {
    # Volume z-score bucket edges. A bar scores "low" strictly below
    # VOLUME_LOW_MAX and "high" strictly above VOLUME_HIGH_MIN; everything
    # between is "normal". The band is deliberately asymmetric: volume is
    # right-skewed, so +1.0 and -0.5 sit at roughly comparable rarity.
    "VOLUME_LOW_MAX": -0.5,
    "VOLUME_HIGH_MIN": 1.0,

    # Time-of-day boundaries.
    #
    # open30 and close30 are defined RELATIVE TO THE SESSION, not to the clock,
    # so that on an early-close day "the last 30 minutes" still means the last
    # 30 minutes. close30 is tested before the clock buckets, which is what
    # makes a half day degrade gracefully: its 12:30-13:00 bars land in close30
    # and the clock buckets that fall after the close simply never occur.
    #
    # morning/midday/afternoon are clock-based because they describe the
    # rhythm of a normal session (the lunchtime lull is at lunchtime, not at
    # 40% of the way through).
    "OPEN30_MINUTES": 30,
    "CLOSE30_MINUTES": 30,
    "MORNING_END": "11:30",   # open30 .. 11:29 is "morning"
    "MIDDAY_END": "14:00",    # 11:30 .. 13:59 is "midday"; then "afternoon"
}


# ---------------------------------------------------------------------------
# Dimension definitions and the integer encoding scheme
# ---------------------------------------------------------------------------
#
# state_id is a mixed-radix integer, little-endian: dimension 0 is the least
# significant "digit", each dimension's radix is its number of possible values.
#
#     state_id = i0 + r0*(i1 + r1*(i2 + r2*(i3 + r3*i4)))
#              = i0*1 + i1*2 + i2*4 + i3*8 + i4*24
#
# With radices (2, 2, 2, 3, 5) that spans 0..119 -- exactly 120 states.
#
# Why little-endian matters: a NEW DIMENSION APPENDED TO THE END becomes the
# most significant digit, with a multiplier larger than any id currently in
# use. Every existing state keeps its id, and the new dimension's first value
# (index 0) reproduces the old numbering exactly. A big-endian scheme would
# renumber all 120 states the moment a sixth dimension appeared.
#
# Two rules follow, and breaking either silently invalidates every state map
# ever written:
#
#   1. Append new DIMENSIONS to the end of DIMENSIONS. Never insert or reorder.
#   2. Append new VALUES to the end of a dimension's value list. Never insert
#      or reorder.

DIMENSIONS: list[tuple[str, list[str]]] = [
    ("price_vs_ema9", ["below", "above"]),
    ("ema9_vs_ema50", ["below", "above"]),
    ("price_vs_vwap", ["below", "above"]),
    ("volume_bucket", ["low", "normal", "high"]),
    ("time_bucket", ["open30", "morning", "midday", "afternoon", "close30"]),
]

DIMENSION_NAMES = [name for name, _ in DIMENSIONS]

# Multiplier per dimension, derived from the radices so it can never fall out
# of sync with the value lists.
def _multipliers() -> list[int]:
    multipliers = []
    running = 1
    for _, values in DIMENSIONS:
        multipliers.append(running)
        running *= len(values)
    return multipliers


MULTIPLIERS = _multipliers()
TOTAL_STATES = 1
for _name, _values in DIMENSIONS:
    TOTAL_STATES *= len(_values)

# Columns encode_state requires on the final row of its window.
REQUIRED_COLUMNS = [
    "close", "ema_fast", "ema_slow", "session_vwap", "volume_zscore",
    "minutes_from_open", "minutes_to_close", "timestamp",
]


@dataclass(frozen=True)
class StateResult:
    """The state of a single bar."""

    state_id: int
    name: str
    price_vs_ema9: str
    ema9_vs_ema50: str
    price_vs_vwap: str
    volume_bucket: str
    time_bucket: str

    def as_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Per-dimension classifiers
# ---------------------------------------------------------------------------

def classify_price_vs_ema9(close: float, ema_fast: float) -> str:
    # Ties go to "above". An exact float equality here is vanishingly rare, but
    # leaving it undefined would make the encoder non-deterministic.
    return "above" if close >= ema_fast else "below"


def classify_ema9_vs_ema50(ema_fast: float, ema_slow: float) -> str:
    return "above" if ema_fast >= ema_slow else "below"


def classify_price_vs_vwap(close: float, vwap: float) -> str:
    return "above" if close >= vwap else "below"


def classify_volume(zscore: float) -> str:
    if zscore < STATE_CONFIG["VOLUME_LOW_MAX"]:
        return "low"
    if zscore > STATE_CONFIG["VOLUME_HIGH_MIN"]:
        return "high"
    return "normal"


def classify_time_of_day(
    timestamp: pd.Timestamp, minutes_from_open: int, minutes_to_close: int
) -> str:
    """Bucket a bar by time of day.

    Order of tests is load-bearing -- see the note in STATE_CONFIG. close30 is
    checked before the clock buckets so that an early close still gets a
    close30, and open30 is checked first so a session whose open sits inside a
    clock bucket is still labelled by its position in the session.
    """
    if minutes_from_open < STATE_CONFIG["OPEN30_MINUTES"]:
        return "open30"
    if minutes_to_close <= STATE_CONFIG["CLOSE30_MINUTES"]:
        return "close30"

    clock = timestamp.strftime("%H:%M")
    if clock < STATE_CONFIG["MORNING_END"]:
        return "morning"
    if clock < STATE_CONFIG["MIDDAY_END"]:
        return "midday"
    return "afternoon"


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------

def compute_state_id(values: dict[str, str]) -> int:
    """Mixed-radix encode dimension values into a stable integer."""
    state_id = 0
    for (name, allowed), multiplier in zip(DIMENSIONS, MULTIPLIERS):
        value = values[name]
        try:
            index = allowed.index(value)
        except ValueError:
            raise ValueError(f"{value!r} is not a valid value for dimension {name!r}") from None
        state_id += index * multiplier
    return state_id


def decode_state_id(state_id: int) -> dict[str, str]:
    """Inverse of compute_state_id -- useful for reading a state map by id."""
    if not 0 <= state_id < TOTAL_STATES:
        raise ValueError(f"state_id {state_id} out of range 0..{TOTAL_STATES - 1}")

    values: dict[str, str] = {}
    remainder = state_id
    for name, allowed in DIMENSIONS:
        radix = len(allowed)
        values[name] = allowed[remainder % radix]
        remainder //= radix
    return values


def state_name(values: dict[str, str]) -> str:
    """Human-readable name, e.g. 'uptrend | above VWAP | high volume | open30'.

    The two EMA dimensions are collapsed into a single trend word because that
    is how a person reads a chart: they do not think "price above the 9 which
    is above the 50", they think "uptrend".
    """
    trend = {
        ("above", "above"): "uptrend",
        ("below", "above"): "uptrend pullback",
        ("above", "below"): "downtrend bounce",
        ("below", "below"): "downtrend",
    }[(values["price_vs_ema9"], values["ema9_vs_ema50"])]

    vwap = f"{values['price_vs_vwap']} VWAP"
    volume = f"{values['volume_bucket']} volume"
    return f"{trend} | {vwap} | {volume} | {values['time_bucket']}"


def encode_state(window: pd.DataFrame) -> StateResult:
    """Encode the LAST bar of `window` into a discrete state.

    This is the single encoding path, used by both historical batch encoding
    and (later) the live agent.

    Contract:
      * `window` is a DataFrame of bars in chronological order, ending at the
        bar to be classified.
      * Only the final row is read. Earlier rows are accepted and ignored, so a
        live caller can pass whatever rolling buffer it already holds without
        trimming it first.
      * The indicator columns must already be present on that final row.
        They are NOT recomputed here, because they cannot be: a 50-bar EMA and
        a 20-session volume baseline need more history than any practical live
        window carries. Both callers get those columns from indicators.py,
        which is what keeps the two paths identical.

    Raises ValueError on an empty window, a missing column, or a NaN indicator
    (a warmup bar) -- these are programming errors at the call site, not states.
    """
    if window is None or len(window) == 0:
        raise ValueError("encode_state requires a non-empty window")

    missing = [c for c in REQUIRED_COLUMNS if c not in window.columns]
    if missing:
        raise ValueError(f"window is missing required column(s): {missing}")

    bar = window.iloc[-1]

    nan_columns = [
        c for c in ("close", "ema_fast", "ema_slow", "session_vwap", "volume_zscore")
        if pd.isna(bar[c])
    ]
    if nan_columns:
        raise ValueError(
            f"cannot encode a bar with NaN in {nan_columns} at {bar['timestamp']} "
            f"-- this bar is still in warmup"
        )

    values = {
        "price_vs_ema9": classify_price_vs_ema9(bar["close"], bar["ema_fast"]),
        "ema9_vs_ema50": classify_ema9_vs_ema50(bar["ema_fast"], bar["ema_slow"]),
        "price_vs_vwap": classify_price_vs_vwap(bar["close"], bar["session_vwap"]),
        "volume_bucket": classify_volume(bar["volume_zscore"]),
        "time_bucket": classify_time_of_day(
            bar["timestamp"], int(bar["minutes_from_open"]), int(bar["minutes_to_close"])
        ),
    }

    return StateResult(
        state_id=compute_state_id(values),
        name=state_name(values),
        **values,
    )


def encode_batch(df: pd.DataFrame, progress_every: int = 20_000) -> pd.DataFrame:
    """Apply encode_state across a dataset, one bar at a time.

    This is intentionally a loop rather than a vectorised reimplementation.
    Each bar is passed as a single-row window, which encode_state treats
    identically to a long live window because it only ever reads the last row.
    6 months x 2 tickers is small data; the seconds this costs buy the
    guarantee that history and live can never disagree.
    """
    encodable = df.loc[~df["warmup"]].reset_index(drop=True)

    results: list[StateResult] = []
    for position in range(len(encodable)):
        window = encodable.iloc[position:position + 1]
        results.append(encode_state(window))
        if progress_every and position and position % progress_every == 0:
            print(f"    encoded {position:,} / {len(encodable):,} bars")

    encoded = pd.DataFrame([r.as_dict() for r in results])
    return pd.concat([encodable, encoded], axis=1)


def build_state_dictionary(encoded: pd.DataFrame) -> pd.DataFrame:
    """Build states.csv: every possible state, its name, dimensions, and count.

    All TOTAL_STATES rows are emitted, including states never observed. A state
    map with holes in it invites the reader to assume a missing id is a bug;
    a count of 0 says plainly that the combination is possible but did not
    occur.
    """
    counts = encoded["state_id"].value_counts() if len(encoded) else pd.Series(dtype=int)

    rows = []
    for state_id in range(TOTAL_STATES):
        values = decode_state_id(state_id)
        rows.append(
            {
                "state_id": state_id,
                "name": state_name(values),
                **values,
                "bar_count": int(counts.get(state_id, 0)),
            }
        )

    dictionary = pd.DataFrame(rows)
    total = dictionary["bar_count"].sum()
    dictionary["pct_of_bars"] = (
        (dictionary["bar_count"] / total * 100).round(3) if total else 0.0
    )
    return dictionary
