# Render Match Lines as a viewport-culled MapLibre line layer

Match Lines are drawn as a native MapLibre GL GeoJSON line layer on the existing
basemap map instance, fed by a viewport-bounded SQL query against the Lines table.
They are **not** rendered in the WebGPU point renderer, and not via a separate engine
(deck.gl). This supersedes the earlier decision to extend the WebGPU renderer with a
line pass.

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

- Lines work wherever MapLibre runs (no WebGPU-only limitation; the WebGL2 fallback path
  is unaffected).
- The Lines table is loaded into DuckDB alongside Points; the layer is refreshed from a
  viewport-bounded query on `moveend`.
- Per-viewport line count is the scaling variable to watch; if a viewport ever holds
  more than ~tens of thousands of lines, revisit deck.gl.
- v1: Match Lines redraw on score filter (and on viewport/zoom change); spatial and
  categorical cross-filter of lines beyond the viewport bbox is deferred.
