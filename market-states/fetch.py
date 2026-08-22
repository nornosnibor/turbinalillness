"""
Polygon.io minute-bar fetching and the immutable raw cache.

This is the only module that talks to the network, and the only step that can
fail for reasons outside this codebase. Everything downstream reads parquet
from disk, so a broken API key or a rate limit can never corrupt processing --
it just means there is nothing new to process.

Cache layout:

    data/raw/SPY/SPY-2026-03.parquet        <- exactly what Polygon returned
    data/raw/SPY/SPY-2026-03.meta.json      <- what date range that file covers

Re-running the pipeline never re-hits the API for data already on disk.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

import config

# Column names Polygon uses in the aggregates response, mapped to readable ones.
# We rename at the boundary so no downstream module has to know that "vw" means
# volume-weighted price or that "t" is a millisecond epoch.
POLYGON_COLUMNS = {
    "t": "timestamp_ms",
    "o": "open",
    "h": "high",
    "l": "low",
    "c": "close",
    "v": "volume",
    "n": "transactions",
    "vw": "vwap_polygon",
}


class PolygonError(RuntimeError):
    """Raised when Polygon returns something we cannot use."""


@dataclass
class MonthChunk:
    """One ticker-month of work: the unit we both fetch and cache."""

    ticker: str
    year: int
    month: int
    start: date  # first day we actually want (clipped to the request window)
    end: date    # last day we actually want (inclusive, clipped)

    @property
    def label(self) -> str:
        return f"{self.year:04d}-{self.month:02d}"

    @property
    def parquet_path(self) -> Path:
        return config.RAW_DIR / self.ticker / f"{self.ticker}-{self.label}.parquet"

    @property
    def meta_path(self) -> Path:
        return config.RAW_DIR / self.ticker / f"{self.ticker}-{self.label}.meta.json"


def month_chunks(ticker: str, start: date, end: date) -> list[MonthChunk]:
    """Split a date range into calendar-month chunks, clipped to the range.

    Chunking by month (rather than by a fixed bar count) keeps cache filenames
    stable and human-readable: you can look at data/raw and immediately see
    which months you hold.
    """
    chunks: list[MonthChunk] = []
    cursor = date(start.year, start.month, 1)

    while cursor <= end:
        # First day of the following month, then step back one day.
        if cursor.month == 12:
            next_month = date(cursor.year + 1, 1, 1)
        else:
            next_month = date(cursor.year, cursor.month + 1, 1)
        month_end = next_month - timedelta(days=1)

        chunks.append(
            MonthChunk(
                ticker=ticker,
                year=cursor.year,
                month=cursor.month,
                start=max(cursor, start),
                end=min(month_end, end),
            )
        )
        cursor = next_month

    return chunks


class PolygonClient:
    """Thin Polygon aggregates client with conservative rate limiting."""

    def __init__(self, api_key: str | None = None):
        # The key is read from the environment and never written to disk, never
        # logged, and never included in any exception message. Request URLs are
        # only ever logged after the key is stripped.
        self.api_key = api_key or os.environ.get("POLYGON_API_KEY")
        if not self.api_key:
            raise PolygonError(
                "POLYGON_API_KEY is not set. Export it before running the fetch step."
            )
        self.session = requests.Session()
        self._last_call_at: float | None = None

    def _throttle(self) -> None:
        """Sleep so that consecutive calls are at least RATE_LIMIT_SECONDS apart."""
        if self._last_call_at is None:
            return
        elapsed = time.monotonic() - self._last_call_at
        wait = config.RATE_LIMIT_SECONDS - elapsed
        if wait > 0:
            time.sleep(wait)

    @staticmethod
    def _safe_url(url: str) -> str:
        """Strip the API key out of a URL so it is safe to print."""
        if "apiKey=" not in url:
            return url
        head, _, tail = url.partition("apiKey=")
        # Keep anything after the key (other query params) but drop the key itself.
        rest = tail.split("&", 1)
        remainder = ("&" + rest[1]) if len(rest) > 1 else ""
        return f"{head}apiKey=***{remainder}"

    def _get(self, url: str, params: dict | None = None) -> dict:
        """GET with throttling, retries, and key-safe error messages."""
        params = dict(params or {})
        params["apiKey"] = self.api_key

        for attempt in range(config.MAX_RETRIES):
            self._throttle()
            try:
                response = self.session.get(url, params=params, timeout=60)
                self._last_call_at = time.monotonic()
            except requests.RequestException as exc:
                # Network-level failure: back off and retry.
                if attempt == config.MAX_RETRIES - 1:
                    raise PolygonError(f"network error after retries: {type(exc).__name__}") from None
                time.sleep(config.RETRY_BACKOFF_SECONDS * (2 ** attempt))
                continue

            if response.status_code == 429:
                # Rate limited despite our pacing -- back off hard and retry.
                sleep_for = config.RATE_LIMIT_SECONDS * (2 ** attempt)
                print(f"    rate limited, sleeping {sleep_for:.0f}s")
                time.sleep(sleep_for)
                continue

            if response.status_code >= 500:
                time.sleep(config.RETRY_BACKOFF_SECONDS * (2 ** attempt))
                continue

            if response.status_code != 200:
                # Note: response.url would contain the key, so we scrub it.
                raise PolygonError(
                    f"HTTP {response.status_code} for {self._safe_url(response.url)}: "
                    f"{response.text[:200]}"
                )

            return response.json()

        raise PolygonError(f"gave up after {config.MAX_RETRIES} attempts")

    def fetch_minute_bars(self, ticker: str, start: date, end: date) -> pd.DataFrame:
        """Fetch raw 1-minute aggregates for [start, end] inclusive.

        Returns the response as-is (UTC millisecond timestamps, pre/post market
        bars included). Cleaning happens downstream -- this is deliberately dumb.
        """
        url = (
            f"{config.POLYGON_BASE_URL}/v2/aggs/ticker/{ticker}/range/1/minute/"
            f"{start.isoformat()}/{end.isoformat()}"
        )
        params = {
            "adjusted": "true",
            "sort": "asc",
            "limit": config.MAX_BARS_PER_CALL,
        }

        frames: list[pd.DataFrame] = []
        payload = self._get(url, params)

        while True:
            status = payload.get("status")
            if status not in ("OK", "DELAYED"):
                raise PolygonError(f"unexpected status {status!r} for {ticker} {start}..{end}")

            results = payload.get("results") or []
            if results:
                frames.append(pd.DataFrame(results))

            # Polygon paginates with next_url when a response is truncated. We
            # size chunks to avoid this, but handle it so a busy month can never
            # silently lose its tail.
            next_url = payload.get("next_url")
            if not next_url:
                break
            payload = self._get(next_url)

        if not frames:
            return pd.DataFrame(columns=list(POLYGON_COLUMNS.values()))

        raw = pd.concat(frames, ignore_index=True)
        raw = raw.rename(columns=POLYGON_COLUMNS)

        keep = [c for c in POLYGON_COLUMNS.values() if c in raw.columns]
        return raw[keep].sort_values("timestamp_ms").reset_index(drop=True)


def _read_meta(chunk: MonthChunk) -> dict | None:
    if not chunk.meta_path.exists():
        return None
    try:
        return json.loads(chunk.meta_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _cache_is_sufficient(chunk: MonthChunk) -> bool:
    """True if the cached file already covers everything this chunk needs.

    The subtlety: the most recent month is usually *partial* when first fetched
    (a 6-month lookback ending mid-August caches an August file holding only
    1st-21st). If we treated any existing file as complete, the rest of August
    would never be fetched on a later run. So the sidecar records the range the
    file actually covers, and we only reuse it when that range spans what we
    now need. Complete past months therefore never re-hit the API; a partial
    trailing month is refetched exactly once, when it grows.
    """
    if not chunk.parquet_path.exists():
        return False

    meta = _read_meta(chunk)
    if meta is None:
        # A parquet with no sidecar came from an unknown range -- refetch rather
        # than trust it.
        return False

    covered_start = date.fromisoformat(meta["covered_start"])
    covered_end = date.fromisoformat(meta["covered_end"])
    return covered_start <= chunk.start and covered_end >= chunk.end


def fetch_and_cache(
    tickers: list[str],
    start: date,
    end: date,
    client: PolygonClient | None = None,
) -> dict[str, list[Path]]:
    """Fetch every ticker-month in the window that is not already cached.

    Returns a map of ticker -> list of parquet paths covering the window, in
    chronological order. The client is created lazily so that a fully cached
    run never even requires POLYGON_API_KEY to be set.
    """
    paths: dict[str, list[Path]] = {}

    for ticker in tickers:
        ticker_paths: list[Path] = []
        chunks = month_chunks(ticker, start, end)
        print(f"\n{ticker}: {len(chunks)} month chunk(s) covering {start} .. {end}")

        for chunk in chunks:
            if _cache_is_sufficient(chunk):
                print(f"  {chunk.label}  cached, skipping API")
                ticker_paths.append(chunk.parquet_path)
                continue

            if client is None:
                client = PolygonClient()

            print(f"  {chunk.label}  fetching {chunk.start} .. {chunk.end} ...", end="", flush=True)
            bars = client.fetch_minute_bars(chunk.ticker, chunk.start, chunk.end)
            print(f" {len(bars):,} bars")

            chunk.parquet_path.parent.mkdir(parents=True, exist_ok=True)
            bars.to_parquet(chunk.parquet_path, index=False)
            chunk.meta_path.write_text(
                json.dumps(
                    {
                        "ticker": chunk.ticker,
                        "covered_start": chunk.start.isoformat(),
                        "covered_end": chunk.end.isoformat(),
                        "row_count": int(len(bars)),
                        "fetched_at_utc": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    },
                    indent=2,
                )
            )
            ticker_paths.append(chunk.parquet_path)

        paths[ticker] = ticker_paths

    return paths


def load_raw(ticker: str, paths: list[Path]) -> pd.DataFrame:
    """Concatenate cached month files for one ticker into a single raw frame.

    The raw cache is immutable: this reads, it never writes back. All cleaning
    happens downstream into data/processed.
    """
    frames = [pd.read_parquet(p) for p in paths if p.exists()]
    if not frames:
        return pd.DataFrame(columns=list(POLYGON_COLUMNS.values()))

    raw = pd.concat(frames, ignore_index=True)
    raw["ticker"] = ticker

    # Month files are fetched on clipped ranges so they should not overlap, but
    # a refetched partial month could produce duplicates if ranges ever shift.
    before = len(raw)
    raw = raw.drop_duplicates(subset=["timestamp_ms"], keep="first")
    if len(raw) != before:
        print(f"  {ticker}: dropped {before - len(raw):,} duplicate raw timestamps")

    return raw.sort_values("timestamp_ms").reset_index(drop=True)
