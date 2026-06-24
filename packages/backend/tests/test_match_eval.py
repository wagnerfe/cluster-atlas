"""Tests for the local match-eval build step (Points + Lines Expected Format)."""

import duckdb
import pandas as pd
import pytest

from embedding_atlas.match_eval import build_match_eval


def _write(run_dir, name, df: pd.DataFrame):
    folder = run_dir / name / "type=place"
    folder.mkdir(parents=True, exist_ok=True)
    df.to_parquet(folder / "part-0.parquet")


@pytest.fixture
def run_dir(tmp_path):
    """A synthetic matcher run exercising every branch the build must handle."""
    candidates = pd.DataFrame(
        {
            "id": ["c1", "c2", "c3", "c4", "c5", "c6"],
            "name": ["a", "b", "c", "d", "e", "f"],
            "longitude": [10.0, 11.0, 12.0, 13.0, None, 15.0],
            "latitude": [50.0, 51.0, 52.0, 53.0, 54.0, 55.0],
            "base_ids": [[], [], [], [], [], []],  # candidate-only column
        }
    )
    baseline = pd.DataFrame(
        {
            "id": ["b1", "b2", "b3", "b4"],
            "name": ["B", "C", "D", "E"],
            "longitude": [10.5, 11.5, 12.5, 13.5],
            "latitude": [50.5, 51.5, 52.5, 53.5],
        }
    )
    matches = pd.DataFrame(
        {
            #         c1→b1   c1→c2   b3→b4   c3 nomatch  c5(nullcoord)→b2  c6→bX(orphan)
            "id": ["c1", "c1", "b3", "c3", "c5", "c6"],
            "record_type": [
                "candidate",
                "candidate",
                "baseline",
                "candidate",
                "candidate",
                "candidate",
            ],
            "base_id": ["b1", "c2", "b4", None, "b2", "bX"],
            "base_record_type": [
                "baseline",
                "candidate",
                "baseline",
                None,
                "baseline",
                "baseline",
            ],
            "composite_score": [0.9, 0.8, 0.7, None, 0.6, 0.5],
            "match_type": [
                "match",
                "match",
                "match",
                "nomatch",
                "match",
                "match",
            ],
            "match_sub_type": ["x", "y", "z", None, "x", "x"],
            "cluster_id": ["k1", "k1", "k2", None, "k3", "k4"],
        }
    )
    _write(tmp_path, "candidates", candidates)
    _write(tmp_path, "baseline", baseline)
    _write(tmp_path, "matches", matches)
    return tmp_path


def test_points_one_row_per_poi(run_dir, tmp_path):
    out = tmp_path / "out"
    r = build_match_eval(run_dir, out)
    # null-coord candidate c5 is dropped from points; 6 candidates + 4 baselines - 1.
    assert r.n_candidates == 6
    assert r.n_baselines == 4
    assert r.n_points == 9
    assert r.n_points_dropped_no_coords == 1

    con = duckdb.connect()
    counts = dict(
        con.execute(
            f"SELECT point_class, count(*) FROM read_parquet('{r.points_path}') "
            "GROUP BY 1"
        ).fetchall()
    )
    # Matched candidates with coords: c1 (id side), c2 (base side of c1→c2),
    # c6 (id side; its base bX is an orphan so the line drops, but c6 is still
    # matched). c5 is matched too but dropped from points for null coords.
    assert counts["matched_candidate"] == 3
    assert counts["unmatched_candidate"] == 2  # c3 (nomatch), c4 (no match row)
    # All four baselines participate in a match row: b1, b4, b3 (id side), and
    # b2 (matched by c5 — b2 is matched even though c5's line is undrawable).
    assert counts["matched_baseline"] == 4
    assert counts.get("unmatched_baseline", 0) == 0
    # no per-match enrichment columns leaked onto points
    cols = [
        c[0]
        for c in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{r.points_path}')"
        ).fetchall()
    ]
    assert "point_class" in cols and "origin" in cols
    assert "composite_score" not in cols and "match_sub_type" not in cols


def test_lines_type_aware_and_drops(run_dir, tmp_path):
    out = tmp_path / "out"
    r = build_match_eval(run_dir, out)
    # 5 match rows; c5 dropped (null coord endpoint), c6→bX dropped (orphan base).
    assert r.n_match_rows == 5
    assert r.n_lines == 3
    assert r.n_lines_dropped == 2
    assert r.pair_type_counts == {
        "candidate->baseline": 1,
        "candidate->candidate": 1,
        "baseline->baseline": 1,
    }

    con = duckdb.connect()
    cols = [
        c[0]
        for c in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{r.lines_path}')"
        ).fetchall()
    ]
    assert cols == [
        "lon1",
        "lat1",
        "lon2",
        "lat2",
        "id",
        "base_id",
        "composite_score",
        "match_pair_type",
    ]


def test_cache_reuse(run_dir, tmp_path):
    out = tmp_path / "out"
    first = build_match_eval(run_dir, out)
    assert first.from_cache is False
    second = build_match_eval(run_dir, out)
    assert second.from_cache is True
    forced = build_match_eval(run_dir, out, force=True)
    assert forced.from_cache is False


def test_missing_subfolder(tmp_path):
    (tmp_path / "candidates" / "type=place").mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        build_match_eval(tmp_path, tmp_path / "out")
