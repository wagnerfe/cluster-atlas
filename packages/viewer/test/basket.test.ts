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

// ``a`` exists under two providers, in different clusters.
const POINTS = `CREATE TABLE points AS SELECT * FROM (VALUES
  ('a', 'meta', 'c1'), ('c', 'meta', 'c1'), ('b', 'foursquare', 'c1'),
  ('a', 'microsoft', 'c2'), ('d', 'meta', 'c2')
) t(id, provider, cluster_id)`;

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
  await conn.run(POINTS);
});

group("addToBasket on the prod prebuild lines schema", () => {
  test("adds the cluster's pairs with every lines column after the annotations", async () => {
    expect(await addToBasket(db, cluster("c1"))).toBe(2);
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
    ]);
    let added = await rows(`SELECT cluster_id, label, label_quality, id, provider FROM ${BASKET_TABLE} ORDER BY id`);
    expect(added).toEqual([
      { cluster_id: "c1", label: null, label_quality: 1, id: "a", provider: "meta" },
      { cluster_id: "c1", label: null, label_quality: 1, id: "c", provider: "meta" },
    ]);
  });

  test("adding the same cluster twice does not duplicate rows", async () => {
    await addToBasket(db, cluster("c1"));
    expect(await addToBasket(db, cluster("c1"))).toBe(2);
    expect(await addToBasket(db, cluster("c2"))).toBe(3);
  });

  test("matches points on (id, provider), not id alone", async () => {
    await addToBasket(db, cluster("c2"));
    expect(await rows(`SELECT id, provider, base_id FROM ${BASKET_TABLE}`)).toEqual([
      { id: "a", provider: "microsoft", base_id: "d" },
    ]);
  });

  test("a basket from a different lines schema is reported and kept", async () => {
    await addToBasket(db, cluster("c1"));
    await conn.run("ALTER TABLE lines ADD COLUMN names VARCHAR");
    await expect(addToBasket(db, cluster("c2"))).rejects.toBeInstanceOf(BasketSchemaMismatchError);
    expect(await basketCount(db)).toBe(2);
  });
});

group("csvSelectSql", () => {
  test("passes the prod schema through unchanged", async () => {
    await addToBasket(db, cluster("c1"));
    let columns = await describe(db, BASKET_TABLE);
    expect(await describe(db, csvSelectSql(BASKET_TABLE, columns))).toEqual(columns);
  });

  test("flattens nested columns of an enriched schema", async () => {
    await conn.run(`CREATE TABLE enriched AS SELECT
      {'primary': 'Cafe', 'common': MAP {'en': 'Cafe'}} AS names,
      [{'freeform': '1 Main St', 'locality': 'Galway'}] AS addresses,
      ['https://a.example', 'https://b.example'] AS websites,
      CAST([] AS VARCHAR[]) AS emails,
      0.5 AS composite_score`);
    let sql = csvSelectSql("enriched", await describe(db, "enriched"));
    expect(await rows(sql)).toEqual([
      {
        "names.primary": "Cafe",
        "names.common": "{en=Cafe}",
        "addresses[0].freeform": "1 Main St",
        "addresses[0].locality": "Galway",
        "websites[0]": "https://a.example",
        "emails[0]": null,
        composite_score: 0.5,
      },
    ]);
  });
});
