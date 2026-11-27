import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { beforeEach, describe as group, expect, test } from "vitest";

import {
  addToBasket,
  BASKET_TABLE,
  BasketSchemaMismatchError,
  basketCount,
  csvSelectSql,
  describe,
  type BasketDB,
} from "../src/charts/instances/basket.js";

// The prod MatchEvalPrebuildJob ``lines`` schema.
const PROD_LINES = `CREATE TABLE lines AS SELECT * FROM (VALUES
  (0.0, 0.0, 1.0, 1.0, 'a', 'meta', 'b', 'foursquare', 0.9, 'candidate->baseline'),
  (0.0, 0.0, 2.0, 2.0, 'c', 'meta', 'b', 'foursquare', 0.8, 'candidate->baseline'),
  (5.0, 5.0, 6.0, 6.0, 'a', 'microsoft', 'd', 'meta', 0.7, 'candidate->baseline')
) t(lon1, lat1, lon2, lat2, id, provider, base_id, base_provider, composite_score, match_pair_type)`;

// ``a`` exists under two providers, in different clusters; ``b`` is listed
// twice; ``kind`` is an ENUM and ``__row_index__`` is internal, as in the viewer.
const POINTS = [
  "CREATE TYPE kind AS ENUM ('baseline', 'candidate')",
  `CREATE TABLE points AS SELECT id, provider, cluster_id, name, address, CAST(kind AS kind) AS kind,
    row_number() OVER () AS __row_index__
  FROM (VALUES
    ('a', 'meta', 'c1', 'Felix', 'Main St', 'candidate'),
    ('c', 'meta', 'c1', 'Cee', 'Third St', 'candidate'),
    ('b', 'foursquare', 'c1', 'David', 'Second St', 'baseline'),
    ('b', 'foursquare', 'c1', 'David', 'Second St', 'baseline'),
    ('a', 'microsoft', 'c2', 'Felix MS', 'Main St', 'candidate'),
    ('d', 'meta', 'c2', 'Dee', 'Fourth St', 'baseline')
  ) t(id, provider, cluster_id, name, address, kind)`,
];

const cluster = (id: string) => `SELECT id, provider, cluster_id FROM points WHERE cluster_id = '${id}'`;

let conn: DuckDBConnection;
let db: BasketDB;

async function rows(sql: string) {
  return (await conn.runAndReadAll(sql)).getRowObjectsJS();
}

beforeEach(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  db = {
    exec: (sql) => conn.run(sql),
    query: (sql) => rows(sql),
  };
  await conn.run(PROD_LINES);
  for (let sql of POINTS) await conn.run(sql);
});

group("addToBasket on the prod prebuild lines schema", () => {
  test("adds the cluster's pairs: annotations, every lines column, then both sides' point columns", async () => {
    expect(await addToBasket(db, cluster("c1"), "points")).toBe(2);
    expect((await describe(db, BASKET_TABLE)).map((c) => c.name)).toEqual([
      "cluster_id",
      "label",
      "label_quality",
      "lon1",
      "lat1",
      "lon2",
      "lat2",
      "id",
      "provider",
      "base_id",
      "base_provider",
      "composite_score",
      "match_pair_type",
      "base_cluster_id",
      "name",
      "base_name",
      "address",
      "base_address",
      "kind",
      "base_kind",
    ]);
    let added = await rows(`SELECT cluster_id, label, label_quality, id, provider FROM ${BASKET_TABLE} ORDER BY id`);
    expect(added).toEqual([
      { cluster_id: "c1", label: null, label_quality: 1, id: "a", provider: "meta" },
      { cluster_id: "c1", label: null, label_quality: 1, id: "c", provider: "meta" },
    ]);
  });

  test("adds the point details of both sides, base side prefixed base_", async () => {
    await addToBasket(db, cluster("c1"), "points");
    let [pair] = await rows(
      `SELECT id, base_id, name, base_name, address, base_address, kind, base_kind
       FROM ${BASKET_TABLE} WHERE id = 'a'`,
    );
    expect(pair).toEqual({
      id: "a",
      base_id: "b",
      name: "Felix",
      base_name: "David",
      address: "Main St",
      base_address: "Second St",
      kind: "candidate",
      base_kind: "baseline",
    });
    let types = Object.fromEntries((await describe(db, BASKET_TABLE)).map((c) => [c.name, c.type]));
    expect([types.kind, types.base_kind]).toEqual(["VARCHAR", "VARCHAR"]);
  });

  test("adding the same cluster twice does not duplicate rows", async () => {
    await addToBasket(db, cluster("c1"), "points");
    expect(await addToBasket(db, cluster("c1"), "points")).toBe(2);
    expect(await addToBasket(db, cluster("c2"), "points")).toBe(3);
  });

  test("matches points on (id, provider), not id alone", async () => {
    await addToBasket(db, cluster("c2"), "points");
    expect(await rows(`SELECT id, provider, base_id FROM ${BASKET_TABLE}`)).toEqual([
      { id: "a", provider: "microsoft", base_id: "d" },
    ]);
  });

  test("a basket from a different lines schema is reported and kept", async () => {
    await addToBasket(db, cluster("c1"), "points");
    await conn.run("ALTER TABLE lines ADD COLUMN names VARCHAR");
    await expect(addToBasket(db, cluster("c2"), "points")).rejects.toBeInstanceOf(BasketSchemaMismatchError);
    expect(await basketCount(db)).toBe(2);
  });
});

group("csvSelectSql", () => {
  test("passes the prod schema through unchanged", async () => {
    await addToBasket(db, cluster("c1"), "points");
    let columns = await describe(db, BASKET_TABLE);
    expect(await describe(db, csvSelectSql(BASKET_TABLE, columns))).toEqual(columns);
  });

  test("keeps nested columns of an enriched schema as one JSON text column each", async () => {
    await conn.run(`CREATE TABLE enriched AS SELECT
      {'primary': 'Cafe', 'common': MAP {'en': 'Cafe'}} AS names,
      [{'freeform': '1 Main St', 'locality': 'Galway'}] AS addresses,
      ['https://a.example', 'https://b.example'] AS websites,
      CAST([] AS VARCHAR[]) AS emails,
      0.5 AS composite_score`);
    let sql = csvSelectSql("enriched", await describe(db, "enriched"));
    expect(await rows(sql)).toEqual([
      {
        names: '{"primary":"Cafe","common":{"en":"Cafe"}}',
        addresses: '[{"freeform":"1 Main St","locality":"Galway"}]',
        websites: '["https://a.example","https://b.example"]',
        emails: "[]",
        composite_score: 0.5,
      },
    ]);
  });
});
