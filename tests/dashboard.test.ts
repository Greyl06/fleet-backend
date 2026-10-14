import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("Dashboard Stats API (/api/dashboard/stats)", () => {
  it("GET /api/dashboard/stats returns real-time aggregated operational metrics", async () => {
    const res = await request(app)
      .get("/api/dashboard/stats")
      .set("x-user-role", "admin");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("activeVehicles");
    expect(typeof res.body.activeVehicles).toBe("number");
    expect(res.body).toHaveProperty("totalVehicles");
    expect(typeof res.body.totalVehicles).toBe("number");
    expect(res.body).toHaveProperty("pmsDueVehicles");
    expect(res.body).toHaveProperty("pmsAlerts");
    expect(res.body).toHaveProperty("pendingPrs");
    expect(typeof res.body.pendingPrs).toBe("number");
    expect(res.body).toHaveProperty("pendingPrTotalValue");
    expect(typeof res.body.pendingPrTotalValue).toBe("number");
    expect(res.body).toHaveProperty("openTsrfCount");
    expect(typeof res.body.openTsrfCount).toBe("number");
    expect(res.body).toHaveProperty("recentActivity");
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });

  it("updates activeVehicles count when a new vehicle is registered", async () => {
    const initialRes = await request(app)
      .get("/api/dashboard/stats")
      .set("x-user-role", "admin");
    const initialTotal = initialRes.body.totalVehicles;

    const uniquePlate = `DASH-${Date.now().toString().slice(-6)}`;
    const createRes = await request(app)
      .post("/api/vehicles")
      .set("x-user-role", "admin")
      .send({
        plateNumber: uniquePlate,
        model: "Dashboard Test Unit",
        vehicleType: "commuter_van",
        currentKm: 100,
        lastPmsKm: 0,
        pmsIntervalKm: 5000,
      });
    expect(createRes.status).toBe(201);

    const updatedRes = await request(app)
      .get("/api/dashboard/stats")
      .set("x-user-role", "admin");
    expect(updatedRes.body.totalVehicles).toBe(initialTotal + 1);
  });
});
