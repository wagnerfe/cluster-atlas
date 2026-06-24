"""The server advertises and serves the secondary 'lines' table (matcher-eval)."""

import json

import duckdb
import pytest
from starlette.testclient import TestClient

from embedding_atlas.data_source import DataSource
from embedding_atlas.server import make_server


@pytest.fixture
def client(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html></html>")

    con = duckdb.connect()
    con.execute("CREATE TABLE dataset AS SELECT * FROM (VALUES (1, 'a')) t(id, name)")
    con.execute(
        'CREATE TABLE "lines" AS SELECT * FROM (VALUES '
        "(0.0, 0.0, 1.0, 1.0, 'candidate->baseline'), "
        "(2.0, 2.0, 3.0, 3.0, 'candidate->candidate')) "
        "t(lon1, lat1, lon2, lat2, match_pair_type)"
    )

    data_props = {
        "data": {
            "table": "dataset",
            "id": "id",
            "lines": {
                "table": "lines",
                "x1": "lon1",
                "y1": "lat1",
                "x2": "lon2",
                "y2": "lat2",
            },
        }
    }
    data_source = DataSource("test-id", None, {"props": data_props})

    app = make_server(
        data_source,
        static_path=str(static),
        duckdb_uri="server",
        duckdb_connection=con,
        lines_parquet=lambda: con.sql('SELECT * FROM "lines"').df().to_parquet(),
        lines_files=["lines.parquet"],
        lines_table_name="lines",
    )
    return TestClient(app)


def test_metadata_advertises_lines(client):
    meta = client.get("/data/metadata.json").json()
    assert meta["database"]["linesFiles"] == ["lines.parquet"]
    assert meta["database"]["linesTable"] == "lines"
    # The props.data.lines descriptor flows through from the DataSource.
    assert meta["props"]["data"]["lines"]["table"] == "lines"


def test_lines_parquet_is_served(client):
    # HEAD carries the media type (the full-content GET path mirrors the
    # existing dataset.parquet mount, which sets it only on HEAD / range).
    head = client.head("/data/lines.parquet")
    assert head.status_code == 200
    assert head.headers["content-type"] == "application/octet-stream"
    resp = client.get("/data/lines.parquet")
    assert resp.status_code == 200
    assert len(resp.content) > 0


def test_lines_table_is_queryable(client):
    resp = client.post(
        "/data/query",
        content=json.dumps(
            {
                "sql": 'SELECT count(*) AS n FROM "lines"',
                "type": "json",
            }
        ),
    )
    assert resp.status_code == 200
    assert resp.json()[0]["n"] == 2
