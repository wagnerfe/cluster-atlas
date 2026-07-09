<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { deepMemo } from "@embedding-atlas/utils";
  import { makeClient } from "@uwdata/mosaic-core";
  import * as SQL from "@uwdata/mosaic-sql";
  import { untrack } from "svelte";

  import Button from "../../widgets/Button.svelte";
  import PaginatorControls from "../../widgets/PaginatorControls.svelte";
  import SegmentedControl from "../../widgets/SegmentedControl.svelte";
  import Cards from "./Cards.svelte";
  import SortOrderControl from "./SortOrderControl.svelte";
  import Table from "./Table.svelte";

  import { IconCardView, IconRight, IconTableView } from "../../assets/icons.js";
  import type { ColumnStyle } from "../../renderers/types.js";
  import { downloadBuffer } from "../../utils/download.js";
  import { isolatedWritable } from "../../utils/store.js";
  import type { ChartViewProps, RowID } from "../chart.js";
  import { instancesQuery } from "./query.js";
  import type { InstancesSpec, InstancesState, SortOrder } from "./types.js";

  let {
    context,
    spec,
    state: chartState,
    height,
    onSpecChange,
    onStateChange,
  }: ChartViewProps<InstancesSpec, InstancesState> = $props();

  // svelte-ignore state_referenced_locally
  let { columnStyles: contextColumnStyles } = context;

  // Merge spec columnStyles with global ones (spec takes precedence)
  let columnStyles = $derived({ ...$contextColumnStyles, ...spec.columnStyles });

  // svelte-ignore state_referenced_locally
  let highlight = context.highlight;
  let isolatedHighlight = isolatedWritable(highlight);

  let viewMode = $derived((spec.viewMode ?? "table") as "table" | "cards");
  let offset = $derived(chartState.offset ?? 0);
  let pageSize = $derived(spec.pageSize ?? 100);

  let contentView = $state.raw<Table | Cards | undefined>(undefined);
  let viewContainer = $state.raw<HTMLElement | undefined>(undefined);

  // Column widths (local state, not persisted)
  let defaultColumnWidths = $state.raw<Record<string, number>>({});

  // ---- Cluster basket (matcher-eval) -------------------------------------
  // Accumulate the match lines of the clusters the user picks (via the map's
  // click-to-filter) into a server-side table, then download it as parquet. Each
  // row carries the ``lines`` columns (minus the rendering-only endpoint coords /
  // match_pair_type) plus ``cluster_id`` and the empty ``label`` / ``label_quality``
  // annotation columns. Only shown when a ``cluster_id`` column is present (the
  // prebuilt matcher-eval format), which also guarantees the ``lines`` table exists.
  const BASKET_TABLE = "__cluster_basket";
  let basketEnabled = $derived(context.columns.some((c) => c.name === "cluster_id"));
  let basketCount = $state.raw(0);
  let basketBusy = $state(false);

  // Extract just the ``cluster_id`` clause(s) from the shared cross-filter,
  // dropping any spatial marquee/lasso brush. The map wires
  // rangeSelection={context.filter}, so a brush publishes into the same filter
  // and — because clusters are tiny (a brushed region spans thousands) — using
  // the whole filter would blow "Add cluster" up to tens of thousands of rows.
  // Matching on the column name is enough: the brush clause references the x/y
  // columns, not cluster_id. Reading the clause (rather than context.highlight)
  // also survives the highlight-clearing re-query that a click triggers.
  function clusterPredicate(): any {
    let clauses = (context.filter as any).clauses ?? [];
    let preds = clauses
      .map((c: any) => c?.predicate)
      .filter((p: any) => p != null && String(p).includes("cluster_id"));
    return preds.length > 0 ? preds : null;
  }

  // Reactive flag driving the "Add cluster" button's enabled state.
  let clusterSelectionActive = $state(false);
  $effect.pre(() => {
    let update = () => {
      clusterSelectionActive = clusterPredicate() != null;
    };
    update();
    context.filter.addEventListener("value", update);
    return () => context.filter.removeEventListener("value", update);
  });

  async function refreshBasketCount() {
    try {
      let r = await context.coordinator.query(SQL.Query.from(BASKET_TABLE).select({ n: SQL.count() }));
      basketCount = Number(r.get(0).n);
    } catch {
      // Table not created yet (no clusters added).
      basketCount = 0;
    }
  }

  // Reflect any basket that survived a page reload (the server table outlives
  // the browser session).
  $effect(() => {
    if (basketEnabled) {
      refreshBasketCount();
    }
  });

  // Add the currently-selected cluster's match lines to the basket. Each row is
  // one ``lines`` row scoped to the cluster by joining to the points that pass
  // the active filter, enriched with the point's ``cluster_id``; deduped on
  // (id, base_id). The rendering-only geometry columns (lon/lat endpoints,
  // match_pair_type) are dropped, and two annotation columns are added for the
  // downstream labelling pass: ``label`` (empty, to be filled with 1/0) and
  // ``label_quality`` (defaults to 1).
  const BASKET_DROP_COLUMNS = ["lon1", "lon2", "lat1", "lat2", "match_pair_type"];
  // Columns pulled to the front of the exported parquet, in this order (they are
  // still kept — just reordered); the remaining ``lines`` columns follow in their
  // natural order. Names must exist in the enriched lines schema.
  const BASKET_FRONT_COLUMNS = [
    "composite_score",
    "names",
    "base_names",
    "addresses",
    "base_addresses",
    "taxonomy",
    "base_taxonomy",
    "websites",
    "base_websites",
    "socials",
    "base_socials",
    "emails",
    "base_emails",
  ];
  async function addClusterToBasket() {
    let pred = clusterPredicate();
    if (!basketEnabled || basketBusy || pred == null) {
      return;
    }
    basketBusy = true;
    try {
      // The clause is ``cluster_id IN (…)`` for the clicked cluster(s), so the
      // matching points already form whole clusters (no brush involved).
      let pointsSub = String(SQL.Query.from(context.table).select("id", "cluster_id").where(pred));
      // Front columns are listed explicitly first, then EXCLUDE'd from ``l.*`` so
      // they are not duplicated; the drop columns are EXCLUDE'd outright.
      let front = BASKET_FRONT_COLUMNS.map((c) => `l."${c}"`).join(", ");
      let exclude = `EXCLUDE (${[...BASKET_FRONT_COLUMNS, ...BASKET_DROP_COLUMNS].join(", ")})`;
      let extra = `p."cluster_id" AS cluster_id,
        CAST(NULL AS INTEGER) AS label,
        CAST(1 AS INTEGER) AS label_quality`;
      let shape = `SELECT ${front}, l.* ${exclude}, ${extra}
        FROM "lines" l JOIN "${context.table}" p ON l."id" = p."id" WHERE FALSE`;
      let insert = `INSERT INTO ${BASKET_TABLE}
        SELECT DISTINCT ${front}, l.* ${exclude}, ${extra}
        FROM "lines" l
        JOIN (${pointsSub}) p ON l."id" = p."id"
        WHERE NOT EXISTS (
          SELECT 1 FROM ${BASKET_TABLE} b WHERE b."id" = l."id" AND b."base_id" = l."base_id"
        );`;
      try {
        await context.coordinator.exec(`
          CREATE TABLE IF NOT EXISTS ${BASKET_TABLE} AS ${shape};
          ${insert}
        `);
      } catch {
        // A basket table left by an earlier build may have a different schema, so
        // CREATE ... IF NOT EXISTS is a no-op and the INSERT fails on the column
        // mismatch. Rebuild it fresh (drops any accumulated rows) and retry once.
        await context.coordinator.exec(`
          DROP TABLE IF EXISTS ${BASKET_TABLE};
          CREATE TABLE ${BASKET_TABLE} AS ${shape};
          ${insert}
        `);
      }
      await refreshBasketCount();
    } finally {
      basketBusy = false;
    }
  }

  async function clearBasket() {
    if (basketBusy) {
      return;
    }
    basketBusy = true;
    try {
      await context.coordinator.exec(`DROP TABLE IF EXISTS ${BASKET_TABLE}`);
      basketCount = 0;
    } finally {
      basketBusy = false;
    }
  }

  // Flattened projection for the CSV export: the annotation/id columns plus the
  // first value of each nested field (structs by field name, lists by [1]).
  const BASKET_CSV_SELECT = `
    SELECT
      label, id, base_id, composite_score,
      names."primary"            AS "names.primary",
      base_names."primary"       AS "base_names.primary",
      addresses[1].freeform      AS "addresses.freeform",
      base_addresses[1].freeform AS "base_addresses.freeform",
      taxonomy."primary"         AS "taxonomy.primary",
      base_taxonomy."primary"    AS "base_taxonomy.primary",
      websites[1]                AS "websites[0]",
      base_websites[1]           AS "base_websites[0]",
      socials[1]                 AS "socials[0]",
      base_socials[1]            AS "base_socials[0]",
      emails[1]                  AS "emails[0]",
      base_emails[1]             AS "base_emails[0]"
    FROM ${BASKET_TABLE}`;

  // Export the basket via the server's /data/selection COPY endpoint (same
  // origin as the page; the API is mounted under /data). Parquet exports the
  // full basket table as-is; CSV exports the flattened projection above.
  async function downloadBasket(format: "parquet" | "csv") {
    if (basketBusy || basketCount == 0) {
      return;
    }
    basketBusy = true;
    try {
      let table = BASKET_TABLE;
      let tempTable: string | null = null;
      if (format === "csv") {
        tempTable = `${BASKET_TABLE}_csv`;
        await context.coordinator.exec(`CREATE OR REPLACE TABLE ${tempTable} AS ${BASKET_CSV_SELECT}`);
        table = tempTable;
      }
      try {
        let resp = await fetch(new URL("data/selection", document.baseURI), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ table, format }),
        });
        if (!resp.ok) {
          throw new Error(`basket export failed: ${resp.status}`);
        }
        downloadBuffer(await resp.arrayBuffer(), `cluster-basket.${format}`);
      } finally {
        if (tempTable) {
          await context.coordinator.exec(`DROP TABLE IF EXISTS ${tempTable}`);
        }
      }
    } finally {
      basketBusy = false;
    }
  }

  // Subscribe to highlight changes
  $effect.pre(() => {
    let isOnMount = true;
    let previousValue: RowID[] | null = null;
    return isolatedHighlight.subscribe((v) => {
      // Don't animate immediately on mount.
      if (isOnMount) {
        isOnMount = false;
        previousValue = v;
        return;
      }
      // Animate when a single new point is added.
      let newIDs = v ?? [];
      let oldIDs = previousValue ?? [];
      let enteringIDs = newIDs.filter((x) => oldIDs.indexOf(x) < 0);
      if (enteringIDs.length == 1) {
        animateToPoint(enteringIDs[0]);
      }
      previousValue = v;
    });
  });

  interface Data {
    data: Record<string, any>[];
    columns: string[];
    offset: number;

    offsetForId?: (id: RowID) => Promise<number | undefined>;
  }

  // Data loading
  let totalCount = $state.raw(0);
  let data = $state.raw<Data | undefined>(undefined);

  // Derive current page and page count for PaginatorControls
  let currentPage = $derived(Math.floor(offset / pageSize));
  let pageCount = $derived(Math.ceil(totalCount / pageSize));

  // Reset the offset and scroll to top.
  function resetOffset() {
    untrack(() => {
      if (offset != 0) {
        onStateChange({ offset: 0 });
      }
      if (viewContainer) {
        viewContainer.scrollTop = 0;
      }
    });
  }

  function createClients(options: {
    query?: string;
    columns?: string[];
    columnStyles: Record<string, ColumnStyle>;
    sort?: SortOrder;
    pageSize: number;
  }) {
    let isOriginalTable = options.query == undefined;
    let baseQuery = (predicate?: SQL.FilterExpr | null) =>
      instancesQuery({ query: options.query, table: context.table, predicate: predicate });

    // Build orderby expressions from sort specification
    let orderByExprs = (options.sort ?? []).map((s) => {
      let col = SQL.column(s.column);
      return s.direction === "descending" ? SQL.desc(col) : SQL.asc(col);
    });

    let columnNames: string[] = [];
    let lastQueryOffset = 0;
    let lastQueryPredicate: SQL.FilterExpr | undefined = undefined;

    let clientTotal = makeClient({
      coordinator: context.coordinator,
      selection: context.filter,
      query: (predicate) => {
        return SQL.Query.from(baseQuery(predicate)).select({ count: SQL.count() });
      },
      queryResult: (result: any) => {
        totalCount = result.get(0).count;
      },
    });

    let client = makeClient({
      coordinator: context.coordinator,
      selection: context.filter,
      prepare: async () => {
        let desc = await context.coordinator.query(SQL.Query.describe(baseQuery()));
        columnNames = desc.toArray().map((x) => x.column_name);
        if (options.columns) {
          let specifiedColumns = new Set(options.columns);
          columnNames = columnNames.filter((x) => specifiedColumns.has(x));
        }
        // Filter out hidden columns
        columnNames = columnNames.filter((col) => options.columnStyles[col]?.display !== "hidden");

        // Get sample data for column widths
        let widthQuery = SQL.Query.from(baseQuery())
          .select(
            Object.fromEntries([
              ...(isOriginalTable ? [["__id__", SQL.column(context.id)]] : []),
              ...columnNames.map((x) => [x, SQL.column(x)]),
            ]),
          )
          .limit(10)
          .offset(0);
        let widthResult = await context.coordinator.query(widthQuery);
        let sampleData = widthResult.toArray();
        defaultColumnWidths = Object.fromEntries(
          columnNames.map((col) => [
            col,
            sampleData.reduce(
              (max: number, row: any) => Math.max(max, widthForContent(row[col])),
              widthForContent(col), // Also take column name into account
            ),
          ]),
        );
      },
      query: (predicate) => {
        lastQueryOffset = offset;
        lastQueryPredicate = predicate;
        return SQL.Query.from(baseQuery(predicate))
          .select(
            Object.fromEntries([
              ...(isOriginalTable ? [["__id__", SQL.column(context.id)]] : []),
              ...columnNames.map((x) => [x, SQL.column(x)]),
            ]),
          )
          .orderby(orderByExprs)
          .limit(options.pageSize)
          .offset(offset);
      },
      queryResult: (result: any) => {
        data = {
          data: result.toArray(),
          columns: columnNames,
          offset: lastQueryOffset,
          offsetForId: isOriginalTable
            ? async (id) => {
                // Build ROW_NUMBER window function with same sort order as main query
                let idOffset = SQL.Query.from(baseQuery(lastQueryPredicate)).select({
                  id: SQL.column(context.id),
                  offset: orderByExprs.length > 0 ? SQL.row_number().orderby(...orderByExprs) : SQL.row_number(),
                });
                let query = SQL.Query.from(idOffset)
                  .select({ offset: SQL.column("offset") })
                  .where(SQL.eq(SQL.column("id"), SQL.literal(id)));
                let result = await context.coordinator.query(query);
                return result.get(0)?.offset;
              }
            : undefined,
        };
      },
    });

    $effect.pre(() => {
      // When offset changes, rerun the query.
      if (offset != lastQueryOffset) {
        client.requestQuery();
      }
    });

    return () => {
      clientTotal.destroy();
      client.destroy();
    };
  }

  // Reset offset and create a new client when critical parts of the spec change
  let clientsParams = $derived.by(
    deepMemo(() => ({
      query: spec.query,
      columns: spec.columns,
      columnStyles: columnStyles,
      sort: spec.sort,
      pageSize: pageSize,
    })),
  );

  $effect.pre(() => {
    resetOffset();
    return createClients(clientsParams);
  });

  // Reset offset when predicate changes
  $effect.pre(() => {
    let callback = () => {
      resetOffset();
    };
    context.filter.addEventListener("value", callback);
    return () => {
      context.filter.removeEventListener("value", callback);
    };
  });

  // Calculate width based on content length
  function widthForContent(content: any): number {
    let characterLength = String(content).length;
    return Math.min(600, Math.max(80, characterLength * 8 + 40));
  }

  const scrollParameters = {
    behavior: "smooth",
    block: "center",
    container: "nearest",
  } as const;

  // Animate to a point. When the point is in the same page, scroll to the point;
  // otherwise, go to the page with the point, and reveal the element directly.
  async function animateToPoint(id: RowID) {
    if (spec.query != null) {
      // For custom queries we do not animate.
      return;
    }
    if (data == null) {
      return;
    }

    // Check if highlighted item is in current page
    let isInCurrentPage = data.data.some((row) => row.__id__ === id);
    if (isInCurrentPage) {
      contentView?.getElementForId(id)?.scrollIntoView(scrollParameters);
    } else {
      let newOffset = await data?.offsetForId?.(id);
      if (newOffset != undefined) {
        // Make sure it's a multiple of page number.
        newOffset = Math.floor(newOffset / pageSize) * pageSize;
        scrollToOnLoadPage = { offset: newOffset, id: id };
        onStateChange({ offset: newOffset });
      }
    }
  }

  let scrollToOnLoadPage = $state.raw<{ offset: number; id: RowID } | undefined>(undefined);

  // Helper effect for animateToPoint, to show the new point when switching to a new page.
  $effect(() => {
    if (!scrollToOnLoadPage) {
      return;
    }
    let scrollTo = scrollToOnLoadPage;
    let currentData = data;
    if (currentData?.offset == scrollTo.offset) {
      scrollToOnLoadPage = undefined;
      untrack(() => {
        contentView?.getElementForId(scrollTo.id)?.scrollIntoView(scrollParameters);
      });
    }
  });

  function handlePageChange(page: number) {
    onStateChange({ offset: page * pageSize });
  }

  function handleLoadNext() {
    onStateChange({ offset: Math.min(totalCount - 1, offset + pageSize) });
  }

  function handleRowClick(rowId: RowID | null | undefined, event: MouseEvent) {
    if (rowId == null) {
      return;
    }
    isolatedHighlight.update((value) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        if (value == null) {
          return [rowId];
        }
        if (value.indexOf(rowId) >= 0) {
          return value.filter((x) => x != rowId);
        } else {
          return [...value, rowId];
        }
      } else {
        if (value != null && value.length == 1 && value.indexOf(rowId) >= 0) {
          return null;
        } else {
          return [rowId];
        }
      }
    });
  }
</script>

<div
  class="w-full flex flex-col overflow-hidden rounded-md bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
  style:height={`${height ?? spec.defaultHeight ?? 500}px`}
>
  <div class="flex items-center justify-between px-2 py-0.5 border-b border-slate-200 dark:border-slate-700 gap-4">
    <div class="flex items-center gap-4 flex-shrink-0">
      <SegmentedControl
        value={viewMode}
        onChange={(v) => onSpecChange({ viewMode: v as "table" | "cards" })}
        options={[
          { value: "table", icon: IconTableView, title: "Table view" },
          { value: "cards", icon: IconCardView, title: "Card view" },
        ]}
      />
      <PaginatorControls currentPage={currentPage} pageCount={pageCount} onChange={handlePageChange} />
      <SortOrderControl value={spec.sort} onChange={(value) => onSpecChange({ sort: value })} />
    </div>
    {#if basketEnabled}
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="text-xs text-slate-500 dark:text-slate-400 select-none whitespace-nowrap">
          Basket: {basketCount.toLocaleString()} pairs
        </span>
        <Button
          label="Add cluster"
          disabled={basketBusy || !clusterSelectionActive}
          onClick={addClusterToBasket}
        />
        <Button label="Parquet" disabled={basketBusy || basketCount == 0} onClick={() => downloadBasket("parquet")} />
        <Button label="CSV" disabled={basketBusy || basketCount == 0} onClick={() => downloadBasket("csv")} />
        <Button label="Clear" disabled={basketBusy || basketCount == 0} onClick={clearBasket} />
      </div>
    {/if}
  </div>

  <div class="flex-1 min-h-0 overflow-auto" bind:this={viewContainer}>
    {#if data != null}
      {#if viewMode === "table"}
        <Table
          bind:this={contentView}
          data={data.data}
          columns={data.columns}
          columnDescs={context.columns}
          columnStyles={columnStyles}
          defaultColumnWidths={defaultColumnWidths}
          highlight={$highlight}
          sort={spec.sort}
          onRowClick={handleRowClick}
          onSortChange={(value) => onSpecChange({ sort: value })}
        />

        {#if offset + pageSize < totalCount}
          <div class="p-3 flex justify-center">
            <button class="px-4 py-2 text-sm flex items-center gap-1" onclick={handleLoadNext}>
              Next Page
              <IconRight />
            </button>
          </div>
        {/if}
      {:else}
        <Cards
          bind:this={contentView}
          data={data.data}
          columns={data.columns}
          columnStyles={columnStyles}
          highlight={$highlight}
          cardTemplate={spec.cardTemplate}
          onRowClick={handleRowClick}
        />

        {#if offset + pageSize < totalCount}
          <div class="p-3 flex justify-center">
            <button class="px-4 py-2 text-sm flex items-center gap-1" onclick={handleLoadNext}>
              Next Page
              <IconRight />
            </button>
          </div>
        {/if}
      {/if}
    {:else}
      <div class="flex items-center justify-center h-full">
        <div class="text-slate-500 dark:text-slate-400">Loading...</div>
      </div>
    {/if}
  </div>
</div>
