# Viewer consumes a pre-built Expected Format; never joins at view time

The matcher-eval viewer loads two pre-built datasets — a Points dataset (the four Point
classes with coordinates) and a Lines dataset (one Match Line per matched pair, with
both endpoints and score). It never performs the candidate↔baseline join itself. At up
to 50M Match Lines the join cannot run on a laptop or in browser DuckDB-WASM (2GB cap),
so building and viewing are fully decoupled and the datasets become a contract.

## Considered Options

- **Pre-built Points + Lines, viewer loads only** (chosen).
- Join at view time via DuckDB httpfs / DuckDB-WASM — rejected: does not scale to 50M
  and couples display latency to a heavy batch operation.

## Consequences

- Two producers of the Expected Format:
  - **Local sample**: the `match-eval` CLI builds Points + Lines from the raw
    `candidates/`, `baseline/`, `matches/` folders.
  - **Prod / S3**: the matching run emits Points + Lines in Expected Format. Reading
    from S3 requires all Expected-Format data present, or it errors — no fallback join.
- The Expected-Format schema is now an interface the matcher run must honor. Changing it
  is a coordinated change across matcher and viewer.
- Term definitions live in `CONTEXT.md` (Expected Format, Point class, Match Line).
