import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ensureDatabaseAndTables } from "../src/db/migrate.js";
import { db } from "../src/db/connection.js";
import { nextDocumentNumber } from "../src/db/document-numbers.js";

describe("document numbering", () => {
  beforeAll(async () => {
    await ensureDatabaseAndTables();
  });

  it("issues unique, increasing numbers under concurrency", async () => {
    const numbers = await Promise.all(
      Array.from({ length: 25 }, () => nextDocumentNumber("PR")),
    );
    const year = new Date().getFullYear();
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const value of numbers) expect(value).toMatch(new RegExp(`^PR-${year}-\\d{4,}$`));

    const suffixes = numbers.map((value) => Number(value.split("-")[2])).sort((a, b) => a - b);
    expect(suffixes[suffixes.length - 1] - suffixes[0]).toBe(numbers.length - 1);
  });

  it("seeds a new year above numbers already stored", async () => {
    const year = 2099;
    await db.execute(sql`DELETE FROM document_counters WHERE prefix = 'WO' AND year = ${year}`);
    const existing = await db.execute<{ max: number | null }>(sql`
      SELECT MAX(substring(work_order_number FROM ${`^WO-${year}-([0-9]+)$`})::integer) AS max
      FROM repair_work_orders
    `);
    const next = await nextDocumentNumber("WO", db, new Date(`${year}-06-01T00:00:00Z`));
    expect(Number(next.split("-")[2])).toBe((existing.rows[0]?.max ?? 0) + 1);
  });
});
