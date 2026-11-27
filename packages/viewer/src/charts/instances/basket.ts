// Copyright (c) 2025 Geospatial Atlas contributors. MIT License.

// Cluster basket (matcher-eval): the SQL behind "Add cluster" and the basket
// exports. Kept free of Svelte/Mosaic so it can be tested against plain DuckDB.
//
// A basket row is one pair: every column of the loaded ``lines`` table as-is,
// then every column of the points table for both sides of the pair (the base
// side prefixed ``base_``). The only column names referenced here are the
// record keys: a record is unique only by (id, provider), so a pair is (id,
// provider, base_id, base_provider).

export const BASKET_TABLE = "__cluster_basket";
export const LINES_TABLE = "lines";
export const BASKET_KEY_COLUMNS = ["id", "provider", "base_id", "base_provider"];
const ANNOTATION_COLUMNS = ["cluster_id", "label", "label_quality"];

export interface BasketDB {
  exec(sql: string): Promise<unknown>;
  query(sql: string): Promise<Record<string, any>[]>;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export class BasketSchemaMismatchError extends Error {
  constructor() {
    super(
      "The basket was created from lines/points tables with a different schema. Clear the basket to start a new one.",
    );
    this.name = "BasketSchemaMismatchError";
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function describe(db: BasketDB, sql: string): Promise<ColumnInfo[]> {
  let rows = await db.query(`DESCRIBE ${sql}`);
  return rows.map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
}

async function tableExists(db: BasketDB, table: string): Promise<boolean> {
  let rows = await db.query(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ${literal(table)}`);
  return Number(rows[0]?.n ?? 0) > 0;
}

// ENUMs (the viewer stores low-cardinality text as ENUM) export as plain text.
function value(alias: string, column: ColumnInfo): string {
  let expr = `${alias}.${quote(column.name)}`;
  return /^ENUM\s*\(/i.test(column.type) ? `CAST(${expr} AS VARCHAR)` : expr;
}

/**
 * The basket rows for the points selected by ``pointsQuery`` (which must yield
 * at least ``id``, ``provider`` and ``cluster_id``), one row per pair: the
 * annotation columns, every ``lines`` column, then each points column for the
 * ``id`` side and the ``base_id`` side (as ``base_<column>``), interleaved. A
 * points column is skipped where its name is already taken (e.g. ``id``,
 * ``provider``, ``base_id``), as are the viewer's internal ``__*`` columns.
 */
export function basketSelectSql(
  pointsQuery: string,
  linesColumns: ColumnInfo[],
  pointsTable: string,
  pointsColumns: ColumnInfo[],
): string {
  let lines = linesColumns.filter((c) => !ANNOTATION_COLUMNS.includes(c.name));
  let taken = new Set([...ANNOTATION_COLUMNS, ...lines.map((c) => c.name)]);
  let pointCols: string[] = [];
  for (let c of pointsColumns.filter((c) => !c.name.startsWith("__"))) {
    for (let [alias, name] of [
      ["a", c.name],
      ["b", `base_${c.name}`],
    ]) {
      if (!taken.has(name)) {
        taken.add(name);
        pointCols.push(`${value(alias, c)} AS ${quote(name)}`);
      }
    }
  }
  let keys = BASKET_KEY_COLUMNS.map((c) => `l.${quote(c)}`).join(", ");
  let points = `(SELECT * FROM ${quote(pointsTable)} QUALIFY row_number() OVER (PARTITION BY "id", "provider") = 1)`;
  return `SELECT
      p."cluster_id" AS cluster_id,
      CAST(NULL AS INTEGER) AS label,
      CAST(1 AS INTEGER) AS label_quality,
      ${[...lines.map((c) => value("l", c)), ...pointCols].join(", ")}
    FROM ${quote(LINES_TABLE)} l
    JOIN (SELECT DISTINCT "id", "provider", "cluster_id" FROM (${pointsQuery})) p
      ON l."id" = p."id" AND l."provider" = p."provider"
    LEFT JOIN ${points} a ON l."id" = a."id" AND l."provider" = a."provider"
    LEFT JOIN ${points} b ON l."base_id" = b."id" AND l."base_provider" = b."provider"
    QUALIFY row_number() OVER (PARTITION BY ${keys}) = 1`;
}

function requireColumns(table: string, columns: ColumnInfo[], required: string[]) {
  let missing = required.filter((r) => !columns.some((c) => c.name == r));
  if (missing.length > 0) {
    throw new Error(`The ${table} table is missing the key column(s): ${missing.join(", ")}`);
  }
}

function sameSchema(a: ColumnInfo[], b: ColumnInfo[]): boolean {
  return a.length == b.length && a.every((c, i) => c.name == b[i].name && c.type == b[i].type);
}

/**
 * Add the lines of the points selected by ``pointsQuery`` to the basket, with
 * both sides' point details from ``pointsTable``; returns the new row count.
 */
export async function addToBasket(db: BasketDB, pointsQuery: string, pointsTable: string): Promise<number> {
  let linesColumns = await describe(db, quote(LINES_TABLE));
  requireColumns(LINES_TABLE, linesColumns, BASKET_KEY_COLUMNS);
  let pointsColumns = await describe(db, quote(pointsTable));
  requireColumns("points", pointsColumns, ["id", "provider"]);
  let select = basketSelectSql(pointsQuery, linesColumns, pointsTable, pointsColumns);
  if (!(await tableExists(db, BASKET_TABLE))) {
    await db.exec(`CREATE TABLE ${BASKET_TABLE} AS SELECT * FROM (${select}) WHERE FALSE`);
  } else if (!sameSchema(await describe(db, BASKET_TABLE), await describe(db, select))) {
    throw new BasketSchemaMismatchError();
  }
  let match = BASKET_KEY_COLUMNS.map((c) => `b.${quote(c)} IS NOT DISTINCT FROM s.${quote(c)}`).join(" AND ");
  await db.exec(`INSERT INTO ${BASKET_TABLE}
    SELECT * FROM (${select}) s
    WHERE NOT EXISTS (SELECT 1 FROM ${BASKET_TABLE} b WHERE ${match})`);
  return basketCount(db);
}

export async function basketCount(db: BasketDB): Promise<number> {
  if (!(await tableExists(db, BASKET_TABLE))) {
    return 0;
  }
  let rows = await db.query(`SELECT count(*) AS n FROM ${BASKET_TABLE}`);
  return Number(rows[0]?.n ?? 0);
}

// ---- CSV flattening ------------------------------------------------------

type ParsedType =
  | { kind: "scalar" }
  | { kind: "other" }
  | { kind: "list"; element: ParsedType }
  | { kind: "struct"; fields: { name: string; type: ParsedType }[] };

// Split on commas that are not nested in parentheses, brackets or quotes.
function splitTopLevel(s: string): string[] {
  let parts: string[] = [];
  let depth = 0;
  let quoteChar: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (quoteChar != null) {
      if (ch == quoteChar) quoteChar = null;
    } else if (ch == '"' || ch == "'") {
      quoteChar = ch;
    } else {
      if (ch == "(" || ch == "[") depth++;
      else if (ch == ")" || ch == "]") depth--;
      else if (ch == "," && depth == 0) {
        parts.push(s.slice(start, i));
        start = i + 1;
      }
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p != "");
}

// Parse a DuckDB type string as printed by DESCRIBE, e.g.
// ``STRUCT("primary" VARCHAR, rules STRUCT(variant VARCHAR)[])[]``.
export function parseDuckDBType(type: string): ParsedType {
  let t = type.trim();
  let list = t.match(/^(.*)\[\d*\]$/s);
  if (list) {
    return { kind: "list", element: parseDuckDBType(list[1]) };
  }
  let struct = t.match(/^STRUCT\s*\((.*)\)$/is);
  if (struct) {
    let fields = splitTopLevel(struct[1]).map((f) => {
      let m = f.match(/^"((?:[^"]|"")*)"\s+(.*)$/s) ?? f.match(/^(\S+)\s+(.*)$/s);
      if (!m) {
        throw new Error(`Cannot parse struct field: ${f}`);
      }
      return { name: m[1].replace(/""/g, '"'), type: parseDuckDBType(m[2]) };
    });
    return { kind: "struct", fields };
  }
  if (/^(MAP|UNION)\s*\(/i.test(t)) {
    return { kind: "other" };
  }
  return { kind: "scalar" };
}

function flatten(expr: string, label: string, type: ParsedType, out: string[]) {
  switch (type.kind) {
    case "scalar":
      out.push(`${expr} AS ${quote(label)}`);
      break;
    case "other":
      out.push(`CAST(${expr} AS VARCHAR) AS ${quote(label)}`);
      break;
    case "list":
      flatten(`${expr}[1]`, `${label}[0]`, type.element, out);
      break;
    case "struct":
      for (let f of type.fields) {
        flatten(`struct_extract(${expr}, ${literal(f.name)})`, `${label}.${f.name}`, f.type, out);
      }
      break;
  }
}

/**
 * A flat projection of ``table`` for CSV: scalars as-is, struct fields as
 * ``col.field``, lists by their first element (``col[0]``), recursively; maps
 * and unions as text.
 */
export function csvSelectSql(table: string, columns: ColumnInfo[]): string {
  let out: string[] = [];
  for (let c of columns) {
    flatten(quote(c.name), c.name, parseDuckDBType(c.type), out);
  }
  return `SELECT ${out.join(", ")} FROM ${table}`;
}
