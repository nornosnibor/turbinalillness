# market-states — SPY/QQQ minute data layer

Fetches, caches, cleans, enriches, and encodes SPY/QQQ 1-minute bars into 120
discrete market states.

**This is the data layer only.** No forward returns, no signals, no
backtesting, no P&L. Those depend on this being correct first.

## Setup

```bash
pip install pandas pyarrow requests pandas_market_calendars
export POLYGON_API_KEY=...      # never hardcoded, never logged
```

## Run

```bash
python run.py                   # 6 months ending yesterday, SPY + QQQ
python run.py --tickers SPY --start 2026-06-01 --end 2026-08-21
python run.py --skip-fetch      # reprocess the raw cache without touching the API
python verify.py                # checks + assertions; run this before trusting output
```

## Modules

| File | Responsibility |
|---|---|
| `config.py` | Paths, API pacing, indicator parameters |
| `fetch.py` | Polygon client, month chunking, rate limiting, immutable raw cache |
| `sessions.py` | UTC→ET conversion, NYSE calendar, RTH filter, minute-grid reindex |
| `indicators.py` | EMA 9/50, session VWAP, minute-of-day volume z-score, warmup |
| `states.py` | `encode_state()` + `STATE_CONFIG` + batch wrapper + state dictionary |
| `verify.py` | Reports for eyeballing, assertions that must pass |
| `run.py` | Orchestration and CLI |

`dev/` holds development-only tools that never run in a real build:
`make_fixture.py` (synthetic Polygon-shaped data) and `test_encoder.py`.

## Outputs

```
data/raw/<TICKER>/<TICKER>-<YYYY-MM>.parquet   immutable API responses
data/processed/bars.parquet                    cleaned + enriched, all bars
data/processed/encoded.parquet                 post-warmup bars with states
data/output/states.csv                         the state map (all 120 states)
```

## Design notes

**One encoder, two callers.** `encode_state(window) -> StateResult` is a pure
function returning the state of the last bar in the window. Batch encoding is
that same function in a loop — deliberately not a vectorised reimplementation.
A live agent calling it per minute is therefore guaranteed to agree with the
historical map. `dev/test_encoder.py` proves a 200-bar window and a 1-bar
window produce identical states.

**Stable state ids.** `state_id` is a mixed-radix integer, little-endian, so an
appended dimension becomes the most significant digit and every existing id
survives. Two rules: append new dimensions to the end of `DIMENSIONS`, append
new values to the end of a dimension's value list. Never insert or reorder.

**Session boundaries come from the NYSE calendar**, never hardcoded. Half days
(210 bars) and the DST changeover need no special case. Bars are labelled by
start time, so the last bar of a normal session is 15:59.

**Missing bars are never silently dropped or interpolated.** Polygon emits no
bar when no qualifying trade occurred; those minutes are inserted with
`is_synthetic=True`, volume 0, and price carried forward. The flag survives
into the final output.

**Volume is scored per minute-of-day**, against the trailing 20 *prior*
sessions, because intraday volume is U-shaped — a plain z-score just relabels
the clock. The current session is excluded from its own baseline, and synthetic
bars are excluded from the baseline statistics.

**Warmup covers both indicators.** A bar is `warmup=True` until the 50-bar EMA
*and* the volume z-score are valid. The z-score is the binding constraint
(~20 sessions), so roughly the first month of a lookback is excluded.

### Known characteristics

- `time_bucket` uses session-relative `open30`/`close30` and clock-based
  `morning`/`midday`/`afternoon`. On a half day the clock buckets after the
  close simply never occur. Boundaries are in `STATE_CONFIG`.
- Each minute-of-day leaves warmup independently, so one or two sessions at the
  warmup boundary are emitted partially. `verify.py` reports them.
