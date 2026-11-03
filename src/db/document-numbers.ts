import { sql } from "drizzle-orm";
import { db } from "./connection.js";

const DOCUMENT_NUMBER_SOURCES = {
  PR: { table: "purchase_requisitions", column: "pr_number" },
  WO: { table: "repair_work_orders", column: "work_order_number" },
  TSRF: { table: "tsrf_requests", column: "request_number" },
} as const;

export type DocumentKind = keyof typeof DOCUMENT_NUMBER_SOURCES;

type Executor = Pick<typeof db, "execute">;

/**
 * Issues the next `<KIND>-<YEAR>-<NNNN>` number from a per-kind, per-year
 * counter row. The atomic UPDATE serialises concurrent callers on that row, so
 * numbers never collide. The first number of a year is seeded from the highest
 * suffix already stored, so numbers issued by the old random scheme are never
 * reused. Gaps are possible when an insert later fails, as with any sequence.
 */
export async function nextDocumentNumber(
  kind: DocumentKind,
  executor: Executor = db,
  now: Date = new Date(),
): Promise<string> {
  const year = now.getFullYear();
  const prefix = `${kind}-${year}-`;

  const incremented = await executor.execute<{ last_value: number }>(sql`
    UPDATE document_counters
    SET last_value = last_value + 1
    WHERE prefix = ${kind} AND year = ${year}
    RETURNING last_value
  `);
  let value = incremented.rows[0]?.last_value;

  if (value === undefined) {
    const { table, column } = DOCUMENT_NUMBER_SOURCES[kind];
    const seeded = await executor.execute<{ last_value: number }>(sql`
      INSERT INTO document_counters (prefix, year, last_value)
      SELECT ${kind}, ${year},
        COALESCE(MAX(substring(${sql.identifier(column)} FROM ${`^${prefix}([0-9]{1,9})$`})::integer), 0) + 1
      FROM ${sql.identifier(table)}
      WHERE ${sql.identifier(column)} LIKE ${`${prefix}%`}
      ON CONFLICT (prefix, year)
      DO UPDATE SET last_value = document_counters.last_value + 1
      RETURNING last_value
    `);
    value = seeded.rows[0]?.last_value;
  }

  if (value === undefined) {
    throw new Error(`Unable to allocate a ${kind} document number.`);
  }
  return `${prefix}${String(value).padStart(4, "0")}`;
}
