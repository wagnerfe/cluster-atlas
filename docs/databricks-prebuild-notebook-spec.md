# Spec: Databricks notebook to prebuild the Expected Format (Points + Lines)

## Purpose

Move the matcher-eval preprocessing off the local machine and onto a Databricks
cluster. The notebook reads a matcher run's raw inputs, performs the same joins and
derivations as the local `embedding_atlas.match_eval` build, and writes two parquet
datasets — **points** and **lines** — in the **Expected Format** the geospatial-atlas
viewer consumes directly. You then download those two folders and display them; the
viewer never re-joins.

This exists because the local DuckDB build is `:memory:`-bound and OOMs at production
scale (≈54M match rows, ≈90M blocking rows). PySpark does the same work across the
cluster with no single-node ceiling.

> **Source of truth.** The transformation logic below mirrors
> `packages/backend/embedding_atlas/match_eval.py` (BUILD_VERSION 4). If the two ever
> diverge, that file wins — keep this notebook in lock-step with it.

---

## 1. Engine & environment

- **PySpark** (Spark SQL / DataFrame API) on a Databricks cluster.
- All transforms are joins + aggregations — no Python row loops, no `.collect()` of row
  data, no pandas. The only driver-side work is reading parameters and the final
  validation counts.
- Recommended cluster: any general-purpose cluster sized for the input; the job is
  shuffle-bound (the `cluster_size` aggregation and the line endpoint joins), so favor a
  few large workers over many tiny ones, and ensure adequate shuffle disk.

## 2. Inputs (files on a path)

A matcher run directory laid out exactly like the local sample. Each input is a folder
of parquet parts (Hive-partitioned `type=place/…` is fine; Spark reads it natively and
exposes `type` as a column):

```
{BASE}/candidates/   # POIs to be matched
{BASE}/baseline/     # reference POIs
{BASE}/matches/      # one row per candidate↔base comparison (match / nomatch)
{BASE}/blocking/     # candidate↔base pairs that entered blocking
{BASE}/idMap/        # id → assigned_id  (only needed once `survivor` is defined)
```

`{BASE}` is a parameter (S3 / DBFS / Unity Catalog Volume URI), e.g.
`s3://.../prod_eval/input/output/run-001`. Read each with `spark.read.parquet(...)`.

### Relevant input schemas (observed)

**candidates** / **baseline** (identical, except `base_ids` is candidate-only):
`id, name, address, name_clean, name_clean_tokens[], address_clean,
address_clean_tokens[], latitude, longitude, house_number, country, normalized_phone,
blocking_keys[], primary_source, signature, provider, primary_category, type`
— candidates also have `base_ids[]`.

**matches**: `id, record_type, base_id, base_record_type, composite_score, cluster_id,
match_type, match_sub_type, type`
- `record_type` / `base_record_type` ∈ {`candidate`, `baseline`} — which folder each
  endpoint id resolves against.
- `match_type` ∈ {`match`, `nomatch`}. Every candidate has a row here.

**blocking**: many columns; only `id, record_type, base_id, base_record_type` are used.

**idMap**: `id, assigned_id, type` — `id` is a candidate id; `assigned_id` is the
canonical/surviving id it was mapped to.

## 3. Output contract (Expected Format)

Two parquet datasets. Write as **partitioned folders** (do NOT `coalesce(1)` the large
points set — see §6). The viewer globs `**/*.parquet`, so multiple parts are expected.

### 3.1 `points/` — one row per POI

Exact output columns, in this spirit (order not significant):

| column | type | notes |
|---|---|---|
| `id` | string | POI id |
| `name` | string | |
| `address` | string | |
| `latitude` | double | **drop the row if null** |
| `longitude` | double | **drop the row if null** |
| `house_number` | string | |
| `country` | string | |
| `normalized_phone` | string | |
| `primary_source` | string | |
| `provider` | string | |
| `primary_category` | string | |
| `type` | string | |
| `origin` | string | `candidate` \| `baseline` |
| `point_class` | string | `matched_candidate` \| `unmatched_candidate` \| `matched_baseline` \| `unmatched_baseline` |
| `history_match` | int | candidate-only; **null on baseline rows** |
| `blocked` | int | candidate-only; **null on baseline rows** |
| `cluster_size` | int | candidates **and** baselines; **null when unmatched** |

**Dropped** memory-heavy / matcher-internal source columns (must NOT appear in output):
`name_clean, name_clean_tokens, address_clean, address_clean_tokens, blocking_keys,
signature, base_ids`. (`base_ids` is read only to derive `history_match`, then dropped.)
These VARCHAR[] arrays + redundant text otherwise dominate both build memory and the
download size.

### 3.2 `lines/` — one row per `match_type='match'`

| column | type | notes |
|---|---|---|
| `lon1`, `lat1` | double | endpoint A (the `id` record), type-aware |
| `lon2`, `lat2` | double | endpoint B (the `base_id` record), type-aware |
| `id` | string | match `id` |
| `base_id` | string | match `base_id` |
| `composite_score` | double | informational |
| `match_pair_type` | string | `"{record_type}->{base_record_type}"`, drives line color |

**Drop** any line where any of the four coordinates is null (endpoint had no coords, or
the endpoint id wasn't found in its folder — an "orphan").

## 4. Transformation logic (PySpark)

Match the local CTEs exactly. Suggested DataFrame plan:

```python
from pyspark.sql import functions as F

cand  = spark.read.parquet(f"{BASE}/candidates")
base  = spark.read.parquet(f"{BASE}/baseline")
match = spark.read.parquet(f"{BASE}/matches")
block = spark.read.parquet(f"{BASE}/blocking")

m = match.filter(F.col("match_type") == "match")   # the only rows that drive lines/clusters

# ---- A unified location lookup (drives type-aware line endpoints) -------------
loc = (
    cand.select("id", F.lit("candidate").alias("rt"), "longitude", "latitude")
    .unionByName(
        base.select("id", F.lit("baseline").alias("rt"), "longitude", "latitude")
    )
)

# ---- Matched sets (type-aware) -----------------------------------------------
matched_cand = (
    m.filter(F.col("record_type") == "candidate").select(F.col("id").alias("pid"))
    .unionByName(
        m.filter(F.col("base_record_type") == "candidate").select(F.col("base_id").alias("pid"))
    ).distinct()
)
matched_base = (
    m.filter(F.col("record_type") == "baseline").select(F.col("id").alias("pid"))
    .unionByName(
        m.filter(F.col("base_record_type") == "baseline").select(F.col("base_id").alias("pid"))
    ).distinct()
)

# ---- blocked: candidate ids that took part in any blocking pair ---------------
blocked_cand = (
    block.filter(F.col("record_type") == "candidate").select(F.col("id").alias("pid"))
    .unionByName(
        block.filter(F.col("base_record_type") == "candidate").select(F.col("base_id").alias("pid"))
    ).distinct()
)

# ---- cluster_size: matches per base_id, assigned to every cluster member ------
csize = m.groupBy("base_id").agg(F.count("*").alias("n"))
members = (
    m.select(F.col("id").alias("pid"), F.col("record_type").alias("rt"), "base_id")
    .unionByName(
        m.select(F.col("base_id").alias("pid"), F.col("base_record_type").alias("rt"), "base_id")
    )
)
pid_size = (
    members.join(csize, "base_id")
    .groupBy("pid", "rt")
    .agg(F.max("n").alias("cluster_size"))      # a record in several clusters takes the max
)

KEEP = ["id","name","address","latitude","longitude","house_number","country",
        "normalized_phone","primary_source","provider","primary_category","type"]

# ---- Points: candidates ------------------------------------------------------
cand_pts = (
    cand
    .join(pid_size.filter(F.col("rt")=="candidate"), cand.id == pid_size.pid, "left")
    .select(
        *[cand[c] for c in KEEP],
        F.lit("candidate").alias("origin"),
        F.when(cand.id.isin([r.pid for r in []]), None)  # NOTE: use semi-joins, not isin
          .alias("_placeholder"),
    )
)
```

> The `matched_*` / `blocked_cand` membership tests should be done with **left-semi /
> left-anti joins** (or a left join + null check), **not** `Column.isin(list)` — the sets
> are tens of millions of rows and must stay distributed. The snippet above marks where;
> implement them as joins. Concretely, for each side:
>
> - `point_class`: left-join the candidate/baseline frame to `matched_cand`/`matched_base`
>   on `id = pid`; non-null ⇒ `matched_*`, else `unmatched_*`.
> - `history_match` (candidates): `F.when(F.col("base_ids").isNotNull(), 1).otherwise(0)`.
> - `blocked` (candidates): left-join to `blocked_cand` on `id = pid`; **null ⇒ 1, non-null
>   ⇒ 0** (blocked = never entered a blocking pair).
> - `cluster_size`: from the `pid_size` left-join above (null when unmatched).
>
> Baselines get `history_match = NULL`, `blocked = NULL` (cast to int), and
> `cluster_size` from `pid_size` filtered to `rt='baseline'`.

Then:

```python
points = (
    cand_pts.unionByName(base_pts, allowMissingColumns=True)   # schema-align like UNION ALL BY NAME
    .filter(F.col("latitude").isNotNull() & F.col("longitude").isNotNull())
)
```

### Lines

```python
e1 = loc.select(F.col("id").alias("aid"), F.col("rt").alias("art"),
                F.col("longitude").alias("lon1"), F.col("latitude").alias("lat1"))
e2 = loc.select(F.col("id").alias("bid"), F.col("rt").alias("brt"),
                F.col("longitude").alias("lon2"), F.col("latitude").alias("lat2"))

lines = (
    m
    .join(e1, (m.id == e1.aid) & (m.record_type == e1.art), "left")
    .join(e2, (m.base_id == e2.bid) & (m.base_record_type == e2.brt), "left")
    .select(
        "lon1","lat1","lon2","lat2",
        m.id, m.base_id, "composite_score",
        F.concat_ws("->", "record_type", "base_record_type").alias("match_pair_type"),
    )
    .filter(
        F.col("lon1").isNotNull() & F.col("lat1").isNotNull() &
        F.col("lon2").isNotNull() & F.col("lat2").isNotNull()
    )
)
```

## 5. `survivor` column — TODO (do not ship yet)

`survivor` is **not yet defined** (flag = id present in idMap? carry `assigned_id`?).
Sketch for when it's decided — join `idMap` (`id → assigned_id`) onto points:

```python
# idMap = spark.read.parquet(f"{BASE}/idMap")
# candidate.id  joins idMap.id           (every candidate is a key here)
# baseline.id   appears only as idMap.assigned_id (936 in the sample)
# survivor = <DEFINITION PENDING>
```

Leave it out of the output schema until defined; adding it later is an additive,
non-breaking change (the viewer carries arbitrary extra columns).

## 6. Output write strategy

```python
points.write.mode("overwrite").parquet(f"{OUT}/points")
lines.write.mode("overwrite").parquet(f"{OUT}/lines")
```

- **Do not `coalesce(1)` points** — at tens of millions of wide-ish rows that forces a
  single task and risks OOM. Let Spark write parts; the viewer globs them. If you want
  fewer files, `repartition(N)` to a modest N (e.g. 8–32) before writing.
- `lines` is small (only `match` rows, 8 narrow columns) — `coalesce(1)` is fine there if
  you want a single file.
- Expected sizes (order of magnitude at your scale): `points` a few GB, `lines` a few
  hundred MB. Both are downloadable; `points` is the one to keep partitioned.
- Write to a volume / S3 prefix you can download from (Databricks CLI, `dbutils.fs.cp`,
  or the Volumes UI).

## 7. How geospatial atlas consumes the output

After download you have local `points/` and `lines/` folders in Expected Format. Launch
the viewer in **prebuilt mode**, which skips the local DuckDB build entirely:

```bash
geospatial-atlas-match-eval --points ./points --lines ./lines
```

- `--points` / `--lines` each accept a single `.parquet` **file**, a **directory** of
  parquet parts, or a glob. A Spark/Databricks partitioned `points/` folder works as-is
  (recursively globbed) — no need to `coalesce(1)`. Across parts the loader uses a
  globally-unique window row id, so point selection/tooltips stay correct.
- Prebuilt mode is mutually exclusive with the `RUN_DIR` build argument; both `--points`
  and `--lines` are required together.

The column names already match the viewer's config (`longitude`/`latitude` for points;
`lon1,lat1,lon2,lat2` + `match_pair_type` for lines; `point_class` as the category), so
no viewer config changes are needed.

## 8. Validation cells (sanity-check before downloading)

Run these and eyeball against expectations:

```python
print("candidates:", cand.count(), "baselines:", base.count())
print("points:", points.count())            # ≈ candidates + baselines − (null-coord rows)
points.groupBy("point_class").count().show()
points.groupBy("origin").agg(
    F.sum(F.col("history_match")).alias("hist1"),
    F.sum(F.when(F.col("blocked")==1,1).otherwise(0)).alias("blocked1"),
    F.count(F.col("cluster_size")).alias("clustered"),
).show()
print("lines:", lines.count())               # ≈ match rows with both endpoints resolvable
lines.groupBy("match_pair_type").count().show()
points.select("cluster_size").summary().show()
```

Spot checks that should hold:
- `history_match`, `blocked` are null for **all** `origin='baseline'` rows.
- `cluster_size` is null exactly for unmatched points; ≥1 for matched.
- `point_class` has exactly the four values; counts of `matched_*` reconcile with the
  distinct matched id sets.
- `lines` count + dropped count = match rows; pair-type breakdown is dominated by
  `candidate->baseline`.

## 9. Parameters (notebook widgets)

- `BASE` — input run-dir URI.
- `OUT` — output URI for `points/` and `lines/`.
- (later) `INCLUDE_SURVIVOR` — once defined.

## 10. Notebook cell outline

1. Widgets / parameters (`BASE`, `OUT`).
2. Reads (§2).
3. `m`, `loc`, matched sets, `blocked_cand`, `csize`/`members`/`pid_size` (§4).
4. Build `cand_pts`, `base_pts`, union → `points` (§4).
5. Build `lines` (§4).
6. Validation (§8) — fail fast if a spot check is wrong.
7. Write (§6).
8. (Optional) print download instructions.
