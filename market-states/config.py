"""
Pipeline-wide configuration.

Everything here is a knob that changes what the data means. Thresholds that
define the *states* themselves live at the top of states.py instead (the spec
calls for a single config dict there), so there is exactly one place to look
for each kind of decision:

    config.py  -> how the data is fetched, cleaned, and measured
    states.py  -> how a measured bar is bucketed into a discrete state
"""

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent

# Overridable so a test/fixture run can point at a completely separate tree and
# never touch the real raw cache. Defaults to <project>/data.
DATA_DIR = Path(os.environ.get("MARKET_STATES_DATA_DIR", PROJECT_ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"              # immutable Polygon responses, one file per ticker-month
PROCESSED_DIR = DATA_DIR / "processed"  # cleaned + enriched bars
OUTPUT_DIR = DATA_DIR / "output"        # states.csv, verification dumps

# ---------------------------------------------------------------------------
# Universe and calendar
# ---------------------------------------------------------------------------

TICKERS = ["SPY", "QQQ"]

MARKET_TZ = "America/New_York"
CALENDAR_NAME = "NYSE"

# ---------------------------------------------------------------------------
# Polygon API
# ---------------------------------------------------------------------------

POLYGON_BASE_URL = "https://api.polygon.io"

# Free tier is 5 calls/minute. We pace at one call per 13s (~4.6/min) rather
# than 12s so that clock jitter can never push us over the limit.
RATE_LIMIT_SECONDS = 13.0

# Polygon returns at most 50,000 bars per call. One calendar month of 1-minute
# bars including pre/post market is roughly 21 sessions x 960 minutes ~= 20,000,
# comfortably under the ceiling, so we chunk by month.
MAX_BARS_PER_CALL = 50_000

# Retries for transient failures (429 rate limit, 5xx). Fetching is the only
# step that can fail for reasons outside this codebase, so it retries; nothing
# downstream does.
MAX_RETRIES = 5
RETRY_BACKOFF_SECONDS = 2.0

# ---------------------------------------------------------------------------
# Indicators
# ---------------------------------------------------------------------------

EMA_FAST_SPAN = 9
EMA_SLOW_SPAN = 50

# False: EMAs run over the RTH-only series with sessions concatenated, so the
# average carries across the overnight gap. This is what charting platforms
# display, which is what makes the states recognisable to a human looking at a
# chart. True resets the EMA at each session open. Flag exists so the
# alternative can be tested later without a rewrite.
EMA_RESET_DAILY = False

# Bars needed before the slow EMA is meaningful. An EMA is defined from bar 1,
# but its first values are dominated by the seed rather than by 50 bars of
# history, so they are marked warmup and excluded from output.
EMA_WARMUP_BARS = EMA_SLOW_SPAN

# Volume z-score: each bar is scored against the same minute-of-day in the
# trailing N *prior* sessions. The current session is always excluded, so a
# bar is never part of its own baseline.
Z_WINDOW_SESSIONS = 20

# Synthetic (no-trade) bars are excluded from the baseline statistics, so a
# given minute-of-day bucket can hold fewer than Z_WINDOW_SESSIONS real
# samples. We require at least this many before emitting a z-score; below it
# the bar stays in warmup rather than getting a z-score built on thin air.
Z_MIN_OBSERVATIONS = 15
