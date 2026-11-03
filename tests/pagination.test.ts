import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { parseOffsetPage } from "../src/routes/pagination.js";

function query(values: Record<string, unknown>): Request["query"] {
  const result: Request["query"] = {};
  Object.assign(result, values);
  return result;
}

describe("offset pagination", () => {
  it("uses a bounded default page", () => {
    expect(parseOffsetPage(query({}))).toEqual({ limit: 100, offset: 0 });
  });

  it("accepts valid limits and offsets", () => {
    expect(
      parseOffsetPage(query({ limit: "250", offset: "1000" })),
    ).toEqual({ limit: 250, offset: 1000 });
  });

  it.each([
    { limit: "0" },
    { limit: "501" },
    { offset: "-1" },
    { offset: "100001" },
    { limit: "1.5" },
    { limit: ["10"] },
  ])("rejects invalid pagination input %#", (values) => {
    expect(parseOffsetPage(query(values))).toBeNull();
  });
});
