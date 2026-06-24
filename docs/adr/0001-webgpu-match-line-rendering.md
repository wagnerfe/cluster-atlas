# Render Match Lines in the WebGPU renderer

We will draw Match Lines by extending the existing WebGPU point renderer with a line
pass, rather than overlaying a separate engine (deck.gl / MapLibre data layers). The
target of up to 50M Match Lines requires the renderer's existing compaction and
indirect-draw machinery (the same path that reaches 322M points) and the shared
Mercator projection — a second engine would re-introduce the zoom-drift sync problem
the e2e suite already guards against and would hit a scale ceiling well below 50M.

## Considered Options

- **Extend the WebGPU renderer with a line primitive** (chosen).
- deck.gl `LineLayer`/`ArcLayer` overlay synced to MapLibre view state — rejected:
  does not scale to 50M and needs continuous projection sync with the point canvas.
- MapLibre GL GeoJSON line layer — rejected: dies far below 50M.

## Consequences

- Lines are **WebGPU-only**. On the WebGL2 fallback, points still render but lines are
  hidden behind a warning banner.
- New work: WGSL line shader, a second GPU buffer of line endpoints, and a new
  `RenderMode` for lines, threaded through `EmbeddingViewMosaic` → `EmbeddingViewImpl`.
- v1: Match Lines redraw on score filter only; spatial/categorical cross-filter of
  lines is deferred. Points keep full cross-filter.
