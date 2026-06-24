# Render Match Lines as a viewport-culled SVG overlay

Match Lines are drawn as `<line>` elements in the embedding view's existing SVG overlay,
projected with the **same** `pointLocation` function the renderer uses for points (and
tooltips/labels), fed by a viewport-bounded SQL query against the Lines table. They are
**not** rendered in the WebGPU point renderer, not via a separate engine (deck.gl), and
not via a MapLibre GeoJSON layer.

> **Why not a MapLibre GeoJSON layer** (the previous plan): GeoJSON source tiling is
> broken in this app's Vite/ESM bundle — vector-tile basemap layers render, but a
> runtime-added GeoJSON source reports loaded yet produces zero features
> (`querySourceFeatures` = 0, nothing paints). The same maplibre build works standalone
> (UMD), so it is a bundling issue, not a maplibre bug. Rather than chase the worker
> bundling, lines are drawn as SVG. Because they are viewport-culled (few on screen) and
> short (≤400 m), SVG is more than fast enough, and reusing `pointLocation` guarantees
> they stay glued to the points and the camera-synced basemap.

## Why this changed

The original decision assumed up to 50M Match Lines had to be drawn simultaneously,
which ruled out MapLibre/deck.gl on scale grounds and pushed everything into the WebGPU
renderer. A later constraint changed the calculus: **every Match Line is ≤ 400 m long.**
At Web Mercator resolution a 400 m line is sub-pixel until roughly zoom 12 — invisible
at the overview scale where millions of points are shown. So Match Lines are inherently
a zoomed-in, inspect-individual-matches feature:

- **Zoom-gated** — hidden below a tunable threshold (~z12) where they'd be invisible.
- **Viewport-culled** — only lines whose endpoints fall in the current viewport are
  queried and drawn (thousands, not 50M). Because lines are ≤ 400 m, an endpoint-bbox
  filter expanded by 400 m catches every visible line.

With at most a viewport's worth of short lines on screen, the 50M-simultaneous scaling
requirement disappears.

## Why MapLibre-native over WebGPU / deck.gl

The custom point renderer is the **camera master**: it computes the viewport and drives
MapLibre every frame via `map.jumpTo` (`EmbeddingViewImpl.svelte`), and point↔basemap
alignment is an e2e-tested invariant. Drawing lines in that same already-synced map
instance gives, for free:

- **Alignment** with the points (same camera, same tested invariant).
- **No new dependency** — MapLibre is already loaded.
- **Zoom gate** via layer `minzoom`; **z-order** correct automatically (basemap canvas
  sits under the point canvas, so lines render beneath points).
- Native color-by-`match_pair_type`, line width, and hover picking.

deck.gl was considered: it scales further *per viewport* (binary attributes + GPU
instancing avoid building GeoJSON feature objects and MapLibre's `geojson-vt` re-tile on
each update), comfortably handling hundreds of thousands–millions of lines per viewport
vs MapLibre's ~tens of thousands. It was rejected for v1 because it adds a dependency and
requires feeding deck a viewState from the renderer's `resolvedViewportState` (MapLibre
here is a follower, not the camera source). The data path (viewport bbox SQL → small
result → render layer) is identical, so switching to deck.gl later is a contained change
if dense-metro viewports at z12 prove to stutter.

## Consequences

- Lines render as DOM SVG — no GPU/worker/GeoJSON dependency, works wherever the rest of
  the overlay does.
- The Lines table is loaded into DuckDB alongside Points; the cached row set is refreshed
  from a viewport-bounded query (debounced) on viewport change, and re-projected each
  frame via `pointLocation` so the lines track pan/zoom.
- Per-viewport line count is the scaling variable to watch. SVG comfortably handles up to
  a few thousand `<line>` elements; if a viewport ever holds more, switch to a `<canvas>`
  overlay (same projection, same data path) or revisit a GPU layer.
- v1: Match Lines redraw on viewport/zoom change; score and other cross-filters are
  deferred.
