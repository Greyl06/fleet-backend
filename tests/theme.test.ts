import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("Theme API (/api/theme)", () => {
  it("GET /api/theme returns the current system theme publicly", async () => {
    const res = await request(app).get("/api/theme");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "default");
    expect(res.body).toHaveProperty("dark");
    expect(res.body).toHaveProperty("light");
    expect(res.body.dark).toHaveProperty("primary");
    expect(res.body.light).toHaveProperty("primary");
  });

  it("PUT /api/theme rejects requests without admin permission", async () => {
    const res = await request(app)
      .put("/api/theme")
      .set("x-user-role", "driver")
      .send({
        presetName: "Custom",
        dark: {
          background: { h: 222, s: 28, l: 8 },
          foreground: { h: 210, s: 40, l: 96 },
          card: { h: 222, s: 24, l: 11 },
          cardForeground: { h: 210, s: 40, l: 96 },
          primary: { h: 100, s: 80, l: 50 },
          primaryForeground: { h: 0, s: 0, l: 100 },
          secondary: { h: 217, s: 33, l: 17 },
          muted: { h: 217, s: 28, l: 16 },
          mutedForeground: { h: 215, s: 20, l: 55 },
          border: { h: 217, s: 24, l: 20 },
          accent: { h: 217, s: 28, l: 16 },
          radius: 8,
          fontSans: "Inter",
        },
        light: {
          background: { h: 220, s: 20, l: 97 },
          foreground: { h: 222, s: 47, l: 11 },
          card: { h: 0, s: 0, l: 100 },
          cardForeground: { h: 222, s: 47, l: 11 },
          primary: { h: 100, s: 80, l: 50 },
          primaryForeground: { h: 0, s: 0, l: 100 },
          secondary: { h: 215, s: 28, l: 93 },
          muted: { h: 215, s: 25, l: 93 },
          mutedForeground: { h: 215, s: 20, l: 46 },
          border: { h: 216, s: 20, l: 88 },
          accent: { h: 215, s: 25, l: 93 },
          radius: 8,
          fontSans: "Inter",
        },
      });
    expect([401, 403]).toContain(res.status);
  });

  it("PUT /api/theme allows admin to update the organization theme", async () => {
    const customPayload = {
      presetName: "Forest Green",
      dark: {
        background: { h: 150, s: 20, l: 7 },
        foreground: { h: 210, s: 40, l: 96 },
        card: { h: 150, s: 20, l: 10 },
        cardForeground: { h: 210, s: 40, l: 96 },
        primary: { h: 142, s: 76, l: 46 },
        primaryForeground: { h: 0, s: 0, l: 100 },
        secondary: { h: 150, s: 20, l: 15 },
        muted: { h: 150, s: 20, l: 15 },
        mutedForeground: { h: 150, s: 20, l: 60 },
        border: { h: 150, s: 20, l: 20 },
        accent: { h: 150, s: 20, l: 15 },
        radius: 12,
        fontSans: "Inter",
      },
      light: {
        background: { h: 140, s: 20, l: 97 },
        foreground: { h: 140, s: 30, l: 10 },
        card: { h: 0, s: 0, l: 100 },
        cardForeground: { h: 140, s: 30, l: 10 },
        primary: { h: 142, s: 70, l: 40 },
        primaryForeground: { h: 0, s: 0, l: 100 },
        secondary: { h: 140, s: 20, l: 92 },
        muted: { h: 140, s: 20, l: 92 },
        mutedForeground: { h: 140, s: 20, l: 45 },
        border: { h: 140, s: 20, l: 85 },
        accent: { h: 140, s: 20, l: 92 },
        radius: 12,
        fontSans: "Inter",
      },
    };

    const res = await request(app)
      .put("/api/theme")
      .set("x-user-role", "admin")
      .send(customPayload);

    expect(res.status).toBe(200);
    expect(res.body.presetName).toBe("Forest Green");
    expect(res.body.dark.primary.h).toBe(142);
    expect(res.body.light.primary.h).toBe(142);

    // Verify it persists in subsequent GET
    const getRes = await request(app).get("/api/theme");
    expect(getRes.status).toBe(200);
    expect(getRes.body.presetName).toBe("Forest Green");
    expect(getRes.body.dark.primary.h).toBe(142);
  });

  it("POST /api/theme/reset resets the theme to default", async () => {
    const res = await request(app)
      .post("/api/theme/reset")
      .set("x-user-role", "admin");

    expect(res.status).toBe(200);
    expect(res.body.presetName).toBe("Ocean Blue (Default)");
  });
});
