import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("health, metrics, and bounded API lists", () => {
  it("keeps liveness independent from downstream checks", async () => {
    const response = await request(app).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports database readiness and exposes Prometheus metrics", async () => {
    const readiness = await request(app).get("/health/ready");
    expect(readiness.status).toBe(200);
    expect(readiness.body).toEqual({ status: "ready" });

    const metrics = await request(app).get("/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain("process_cpu_user_seconds_total");
  });

  it("bounds maintenance list pages and rejects invalid limits", async () => {
    const headers = {
      "x-user-id": "pagination-test-admin",
      "x-user-role": "admin",
      "x-user-name": "Pagination Test",
    };
    const page = await request(app)
      .get("/api/maintenance/repair?limit=1&offset=0")
      .set(headers);
    expect(page.status).toBe(200);
    expect(Array.isArray(page.body)).toBe(true);
    expect(page.body.length).toBeLessThanOrEqual(1);
    expect(page.headers["x-page-limit"]).toBe("1");

    const invalid = await request(app)
      .get("/api/maintenance/repair?limit=501")
      .set(headers);
    expect(invalid.status).toBe(400);
  });
});
