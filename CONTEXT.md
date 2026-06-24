# Context

Glossary for the Geospatial Atlas matcher-visualization work. Terms only — no implementation.

## Glossary

### Candidate

A point-of-interest record from the `candidates` folder. Join key: `id`. Coordinates:
`latitude`/`longitude`. Matched if its `id` participates in any `match` row — on either
side (as `id` with `record_type='candidate'`, or as `base_id` with
`base_record_type='candidate'`). Split into Matched Candidate and Unmatched Candidate.

### Baseline POI

A point-of-interest record from the `baseline` folder. Join key: `id`. Coordinates:
`latitude`/`longitude`. Matched if its `id` participates in any `match` row on either
side (as `id` with `record_type='baseline'`, or as `base_id` with
`base_record_type='baseline'`). Split into Matched Baseline and Unmatched Baseline. One
Baseline POI may be matched by several Candidates (one Match Line each).

### Match Result

A row in the matches output linking two records. The endpoints are **type-aware**: `id`
resolves against `candidates` if `record_type='candidate'` else `baseline`; `base_id`
resolves against `candidates` if `base_record_type='candidate'` else `baseline`.
Observed pair types: candidate→baseline (normal), candidate→candidate, baseline→baseline.
`match_type` ∈ {`match`, `nomatch`} alone decides whether a Match Line is drawn: `match`
→ line, `nomatch` (null `base_id`) → no line. `composite_score` is informational only;
it does not gate line drawing.

### Match Pair Type

The ordered kind of a Match Line's endpoints — candidate→baseline, candidate→candidate,
or baseline→baseline — derived from `record_type`/`base_record_type`. Each pair type is
rendered in a distinct line color.

### Match Line

The line drawn between the two records of a `match_type='match'` Match Result, from the
`id` endpoint to the `base_id` endpoint (each placed by its type-aware folder lookup).
One per `match` row. Colored by Match Pair Type. Every Match Line is ≤ 400 m long, so it
is sub-pixel below ~zoom 12 — Match Lines are a zoomed-in inspection feature, rendered as
a viewport-culled MapLibre line layer above a tunable zoom threshold (see ADR-0001), not
as a WebGPU primitive. Up to 50M exist in total, but only a viewport's worth is ever
drawn at once.

### Point class

The four mutually-exclusive colors on the map: Matched Candidate, Unmatched Candidate,
Matched Baseline, Unmatched Baseline. Drives categorical coloring of points.

### Expected Format

The contract the viewer consumes: a pre-built Points dataset and a pre-built Lines
dataset. The viewer never joins at view time — it only loads these. Each dataset is
**either a single `.parquet` file or a directory of parquet parts** (flat or Hive-
partitioned, e.g. `type=place/…`); the loader globs `**/*.parquet`.

- **Points dataset**: candidates ∪ baselines, exactly one row per POI, tagged with
  Point class and an `origin` (candidate/baseline), carrying **all** its own source
  columns verbatim (including matcher internals — `*_clean`, token arrays,
  `blocking_keys`, `signature`). **No match enrichment** is denormalized onto points: a
  POI may participate in several matches, so all match detail lives in the Lines dataset
  (joinable by `id`/`base_id`). The union is schema-aligned: columns absent on one side
  are null-filled. A point is displayed as-is; the line carries the match information.
- **Lines dataset**: one Match Line per `match_type='match'` pair. Columns:
  `lon1, lat1, lon2, lat2` (the two type-aware endpoints), `id, base_id` (the pair),
  `composite_score` (informational), `match_pair_type` (drives line color).

Produced two ways:
- **Local sample**: the `match-eval` CLI builds Points + Lines from the raw
  `candidates/`, `baseline/`, `matches/` folders (no line data present yet) and writes
  them to a local cache dir (keyed by run path), rebuilt only when inputs are newer.
- **Prod / S3**: the matching run itself emits Points + Lines in Expected Format as
  `points/` and `lines/` folders inside the output dir, alongside the raw inputs.
  Reading from S3 requires all Expected-Format data present, or it errors — no build.

### match-eval

The CLI entry point. Given a local run directory, builds the Expected Format (join +
line construction) and launches the viewer. Given S3 in Expected Format, loads directly.
