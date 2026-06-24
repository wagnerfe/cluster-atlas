# Copyright (c) 2025 Apple Inc. Licensed under MIT License.

"""Build the matcher-eval Expected Format (Points + Lines) from a matcher run.

This is the *local* build step described in
``docs/adr/0002-decoupled-expected-format-contract.md``: it reads the raw
``candidates/``, ``baseline/`` and ``matches/`` folders produced by a matcher run
and writes two pre-built datasets the viewer can consume directly:

- **points.parquet** — candidates ∪ baselines, one row per POI, tagged with
  ``point_class`` and carrying every source column verbatim, plus the Match Result
  fields on matched-candidate rows.
- **lines.parquet** — one Match Line per ``match_type='match'`` row, with both
  type-aware endpoints, the pair identity, ``composite_score`` and ``match_pair_type``.

Endpoint resolution is type-aware (see ``CONTEXT.md``): ``id`` resolves against
``candidates`` when ``record_type='candidate'`` else ``baseline``; ``base_id`` resolves
against ``candidates`` when ``base_record_type='candidate'`` else ``baseline``.

The viewer never performs this join — it only loads the outputs.
"""

import json
import logging
from dataclasses import asdict, dataclass
from pathlib import Path

import click
import duckdb
from platformdirs import user_cache_path

from .cache import sha256_hexdigest
from .utils import apply_logging_config

logger = logging.getLogger("embedding-atlas")

# Subfolders expected inside a matcher run directory.
CANDIDATES_DIR = "candidates"
BASELINE_DIR = "baseline"
MATCHES_DIR = "matches"

# Version the build logic so a code change invalidates stale cached outputs.
BUILD_VERSION = 1


@dataclass
class MatchEvalBuild:
    """Result of a build: output paths and the stats worth logging."""

    points_path: str
    lines_path: str
    n_candidates: int
    n_baselines: int
    n_points: int
    n_points_dropped_no_coords: int
    n_match_rows: int
    n_lines: int
    n_lines_dropped: int
    pair_type_counts: dict[str, int]
    from_cache: bool


def _glob_for(path: Path) -> str:
    """Return a DuckDB read_parquet glob for a dataset that may be a single file
    or a directory of parts (flat or Hive-partitioned)."""
    if path.is_dir():
        return str(path / "**" / "*.parquet")
    return str(path)


def _list_input_files(*globs: str) -> list[tuple[str, int, int]]:
    """Resolve globs to a sorted list of (path, size, mtime_ns) for cache keying."""
    out: list[tuple[str, int, int]] = []
    for g in globs:
        for p in sorted(Path().glob(g) if not Path(g).is_absolute() else _abs_glob(g)):
            st = p.stat()
            out.append((str(p), st.st_size, st.st_mtime_ns))
    return sorted(out)


def _abs_glob(glob: str) -> list[Path]:
    # pathlib can't glob an absolute pattern directly; split at the first wildcard.
    parts = Path(glob).parts
    for i, part in enumerate(parts):
        if any(ch in part for ch in "*?["):
            root = Path(*parts[:i]) if i > 0 else Path("/")
            pattern = str(Path(*parts[i:]))
            return list(root.glob(pattern))
    p = Path(glob)
    return [p] if p.exists() else []


def _resolve_run_dir(run_dir: Path) -> tuple[Path, Path, Path]:
    """Locate the candidates/baseline/matches inputs inside a run directory."""
    candidates = run_dir / CANDIDATES_DIR
    baseline = run_dir / BASELINE_DIR
    matches = run_dir / MATCHES_DIR
    missing = [d.name for d in (candidates, baseline, matches) if not d.exists()]
    if missing:
        raise FileNotFoundError(
            f"Run directory {run_dir} is missing expected subfolder(s): "
            f"{', '.join(missing)}. Expected {CANDIDATES_DIR}/, {BASELINE_DIR}/, "
            f"{MATCHES_DIR}/."
        )
    return candidates, baseline, matches


def _default_out_dir(cand_glob: str, base_glob: str, match_glob: str) -> Path:
    """A cache directory keyed by the resolved input files (path/size/mtime)."""
    files = _list_input_files(cand_glob, base_glob, match_glob)
    key = sha256_hexdigest([BUILD_VERSION, files], scope="match_eval")
    return user_cache_path("embedding_atlas") / "match_eval" / key


def build_match_eval(
    run_dir: str | Path,
    out_dir: str | Path | None = None,
    *,
    force: bool = False,
) -> MatchEvalBuild:
    """Build Points + Lines parquet from a local matcher run directory.

    Args:
        run_dir: directory containing ``candidates/``, ``baseline/``, ``matches/``.
        out_dir: where to write ``points.parquet`` / ``lines.parquet``. If None, a
            content-addressed cache directory is used and reused across runs.
        force: rebuild even if a valid cached build already exists.

    Returns:
        A :class:`MatchEvalBuild` with output paths and stats.
    """
    run_dir = Path(run_dir).expanduser().resolve()
    candidates, baseline, matches = _resolve_run_dir(run_dir)
    cand_glob = _glob_for(candidates)
    base_glob = _glob_for(baseline)
    match_glob = _glob_for(matches)

    if out_dir is None:
        out_dir = _default_out_dir(cand_glob, base_glob, match_glob)
    out_dir = Path(out_dir).expanduser().resolve()
    points_path = out_dir / "points.parquet"
    lines_path = out_dir / "lines.parquet"
    manifest_path = out_dir / "manifest.json"

    cached = _load_cached(manifest_path, points_path, lines_path)
    if cached is not None and not force:
        logger.info("match-eval: using cached build at %s", out_dir)
        cached.from_cache = True
        return cached

    out_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    try:
        result = _run_build(
            con, cand_glob, base_glob, match_glob, points_path, lines_path
        )
    finally:
        con.close()

    manifest_path.write_text(json.dumps(asdict(result), indent=2))
    _log_summary(result)
    return result


def _run_build(
    con: duckdb.DuckDBPyConnection,
    cand_glob: str,
    base_glob: str,
    match_glob: str,
    points_path: Path,
    lines_path: Path,
) -> MatchEvalBuild:
    p = {
        "cand": cand_glob,
        "base": base_glob,
        "match": match_glob,
    }

    n_candidates = con.execute(
        "SELECT count(*) FROM read_parquet($cand)", {"cand": cand_glob}
    ).fetchone()[0]
    n_baselines = con.execute(
        "SELECT count(*) FROM read_parquet($base)", {"base": base_glob}
    ).fetchone()[0]
    n_match_rows = con.execute(
        "SELECT count(*) FROM read_parquet($match) WHERE match_type='match'",
        {"match": match_glob},
    ).fetchone()[0]

    # ---- Points -------------------------------------------------------------
    # Matched if the id participates in any match row on either side, with the
    # side's record-type matching this point's origin folder.
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE _points AS
        WITH m AS (
            SELECT * FROM read_parquet($match) WHERE match_type='match'
        ),
        matched_cand AS (
            SELECT id AS pid FROM m WHERE record_type='candidate'
            UNION
            SELECT base_id AS pid FROM m WHERE base_record_type='candidate'
        ),
        matched_base AS (
            SELECT id AS pid FROM m WHERE record_type='baseline'
            UNION
            SELECT base_id AS pid FROM m WHERE base_record_type='baseline'
        ),
        cand AS (
            SELECT c.*, 'candidate' AS origin,
                CASE WHEN c.id IN (SELECT pid FROM matched_cand)
                     THEN 'matched_candidate' ELSE 'unmatched_candidate' END
                AS point_class
            FROM read_parquet($cand) c
        ),
        base AS (
            SELECT b.*, 'baseline' AS origin,
                CASE WHEN b.id IN (SELECT pid FROM matched_base)
                     THEN 'matched_baseline' ELSE 'unmatched_baseline' END
                AS point_class
            FROM read_parquet($base) b
        )
        -- One row per POI: own columns verbatim + origin + point_class. No
        -- per-match enrichment — a POI may have several matches, so all match
        -- detail lives in the Lines dataset (joinable by id / base_id).
        SELECT * FROM cand
        UNION ALL BY NAME
        SELECT * FROM base
        """,
        p,
    )

    n_points_all = con.execute("SELECT count(*) FROM _points").fetchone()[0]
    con.execute(
        """
        COPY (
            SELECT * FROM _points
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        ) TO $out (FORMAT parquet)
        """,
        {"out": str(points_path)},
    )
    n_points = con.execute(
        "SELECT count(*) FROM read_parquet($out)", {"out": str(points_path)}
    ).fetchone()[0]
    n_points_dropped_no_coords = n_points_all - n_points

    # ---- Lines --------------------------------------------------------------
    # Type-aware endpoint resolution via record_type / base_record_type.
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE _lines AS
        WITH m AS (
            SELECT * FROM read_parquet($match) WHERE match_type='match'
        ),
        cand AS (SELECT id, longitude, latitude FROM read_parquet($cand)),
        base AS (SELECT id, longitude, latitude FROM read_parquet($base))
        SELECT
            CASE WHEN m.record_type='candidate' THEN c1.longitude
                 ELSE b1.longitude END AS lon1,
            CASE WHEN m.record_type='candidate' THEN c1.latitude
                 ELSE b1.latitude  END AS lat1,
            CASE WHEN m.base_record_type='candidate' THEN c2.longitude
                 ELSE b2.longitude END AS lon2,
            CASE WHEN m.base_record_type='candidate' THEN c2.latitude
                 ELSE b2.latitude  END AS lat2,
            m.id              AS id,
            m.base_id         AS base_id,
            m.composite_score AS composite_score,
            m.record_type || '->' || m.base_record_type AS match_pair_type
        FROM m
        LEFT JOIN cand c1 ON m.record_type='candidate'      AND m.id      = c1.id
        LEFT JOIN base b1 ON m.record_type='baseline'       AND m.id      = b1.id
        LEFT JOIN cand c2 ON m.base_record_type='candidate' AND m.base_id = c2.id
        LEFT JOIN base b2 ON m.base_record_type='baseline'  AND m.base_id = b2.id
        """,
        p,
    )

    con.execute(
        """
        COPY (
            SELECT lon1, lat1, lon2, lat2, id, base_id,
                   composite_score, match_pair_type
            FROM _lines
            WHERE lon1 IS NOT NULL AND lat1 IS NOT NULL
              AND lon2 IS NOT NULL AND lat2 IS NOT NULL
        ) TO $out (FORMAT parquet)
        """,
        {"out": str(lines_path)},
    )
    n_lines = con.execute(
        "SELECT count(*) FROM read_parquet($out)", {"out": str(lines_path)}
    ).fetchone()[0]
    n_lines_dropped = n_match_rows - n_lines

    pair_type_counts = dict(
        con.execute(
            "SELECT match_pair_type, count(*) FROM read_parquet($out) "
            "GROUP BY 1 ORDER BY 2 DESC",
            {"out": str(lines_path)},
        ).fetchall()
    )

    return MatchEvalBuild(
        points_path=str(points_path),
        lines_path=str(lines_path),
        n_candidates=n_candidates,
        n_baselines=n_baselines,
        n_points=n_points,
        n_points_dropped_no_coords=n_points_dropped_no_coords,
        n_match_rows=n_match_rows,
        n_lines=n_lines,
        n_lines_dropped=n_lines_dropped,
        pair_type_counts=pair_type_counts,
        from_cache=False,
    )


def _load_cached(
    manifest_path: Path, points_path: Path, lines_path: Path
) -> MatchEvalBuild | None:
    if not (manifest_path.exists() and points_path.exists() and lines_path.exists()):
        return None
    try:
        data = json.loads(manifest_path.read_text())
        return MatchEvalBuild(**data)
    except Exception:
        logger.debug("match-eval: cache manifest unreadable", exc_info=True)
        return None


def _log_summary(r: MatchEvalBuild) -> None:
    logger.info(
        "match-eval build: %d candidates + %d baselines -> %d points "
        "(%d dropped: no coords)",
        r.n_candidates,
        r.n_baselines,
        r.n_points,
        r.n_points_dropped_no_coords,
    )
    logger.info(
        "match-eval build: %d match rows -> %d lines (%d dropped: unresolved / "
        "no coords). Pair types: %s",
        r.n_match_rows,
        r.n_lines,
        r.n_lines_dropped,
        r.pair_type_counts,
    )


@click.command(name="match-eval")
@click.argument("run_dir", type=click.Path(exists=True, file_okay=False))
@click.option(
    "--out",
    "out_dir",
    type=click.Path(file_okay=False),
    default=None,
    help="Output directory for points.parquet / lines.parquet. "
    "Defaults to a content-addressed cache directory.",
)
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Rebuild even if a valid cached build already exists.",
)
def match_eval_cli(run_dir: str, out_dir: str | None, force: bool):
    """Build the matcher-eval Expected Format (Points + Lines) from a run directory.

    RUN_DIR must contain candidates/, baseline/ and matches/ subfolders.
    """
    apply_logging_config()
    result = build_match_eval(run_dir, out_dir, force=force)
    click.echo()
    click.echo(click.style("  Points: ", bold=True) + result.points_path)
    click.echo(click.style("  Lines:  ", bold=True) + result.lines_path)


if __name__ == "__main__":
    match_eval_cli()
