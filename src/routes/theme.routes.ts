import { Router, Request, Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { systemThemes } from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";

export const themeRouter = Router();

const hslColorSchema = z.object({
  h: z.number().min(0).max(360),
  s: z.number().min(0).max(100),
  l: z.number().min(0).max(100),
});

const themeVarsSchema = z.object({
  background: hslColorSchema,
  foreground: hslColorSchema,
  card: hslColorSchema,
  cardForeground: hslColorSchema,
  primary: hslColorSchema,
  primaryForeground: hslColorSchema,
  secondary: hslColorSchema,
  muted: hslColorSchema,
  mutedForeground: hslColorSchema,
  border: hslColorSchema,
  accent: hslColorSchema,
  radius: z.number().min(0).max(32),
  fontSans: z.string().min(1).max(100),
});

const updateThemeSchema = z.object({
  presetName: z.string().nullable().optional(),
  dark: themeVarsSchema,
  light: themeVarsSchema,
});

const DEFAULT_THEME_RESPONSE = {
  id: "default",
  presetName: "Ocean Blue (Default)",
  dark: {
    background: { h: 222, s: 28, l: 8 },
    foreground: { h: 210, s: 40, l: 96 },
    card: { h: 222, s: 24, l: 11 },
    cardForeground: { h: 210, s: 40, l: 96 },
    primary: { h: 217, s: 91, l: 60 },
    primaryForeground: { h: 222, s: 47, l: 11 },
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
    primary: { h: 221, s: 83, l: 53 },
    primaryForeground: { h: 210, s: 40, l: 98 },
    secondary: { h: 215, s: 28, l: 93 },
    muted: { h: 215, s: 25, l: 93 },
    mutedForeground: { h: 215, s: 20, l: 46 },
    border: { h: 216, s: 20, l: 88 },
    accent: { h: 215, s: 25, l: 93 },
    radius: 8,
    fontSans: "Inter",
  },
  updatedBy: "System",
  updatedAt: new Date().toISOString(),
};

// GET /api/theme - Read the organization's current active theme
themeRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const [row] = await db
      .select()
      .from(systemThemes)
      .where(eq(systemThemes.id, "default"))
      .limit(1);

    if (!row) {
      res.json(DEFAULT_THEME_RESPONSE);
      return;
    }

    res.setHeader("Cache-Control", "no-cache");
    res.json({
      id: row.id,
      presetName: row.presetName,
      dark: JSON.parse(row.darkVarsJson),
      light: JSON.parse(row.lightVarsJson),
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    });
  } catch (err: unknown) {
    const error = err as Error;
    // Fallback to default in case database is momentarily inaccessible
    res.json(DEFAULT_THEME_RESPONSE);
  }
});

// PUT /api/theme - Admin publishes an updated organization-wide theme
themeRouter.put("/", requirePermission("manage", "all"), async (req: Request, res: Response) => {
  const parsed = updateThemeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid theme payload",
      details: parsed.error.flatten(),
    });
    return;
  }

  const { presetName, dark, light } = parsed.data;
  const updatedBy = req.user?.name || req.user?.id || "Admin";

  try {
    const [saved] = await db
      .insert(systemThemes)
      .values({
        id: "default",
        presetName: presetName ?? null,
        darkVarsJson: JSON.stringify(dark),
        lightVarsJson: JSON.stringify(light),
        updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemThemes.id,
        set: {
          presetName: presetName ?? null,
          darkVarsJson: JSON.stringify(dark),
          lightVarsJson: JSON.stringify(light),
          updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();

    res.json({
      id: saved.id,
      presetName: saved.presetName,
      dark: JSON.parse(saved.darkVarsJson),
      light: JSON.parse(saved.lightVarsJson),
      updatedBy: saved.updatedBy,
      updatedAt: saved.updatedAt,
    });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: "Failed to persist organization theme", message: error.message });
  }
});

// POST /api/theme/reset - Admin resets the organization theme to factory default
themeRouter.post("/reset", requirePermission("manage", "all"), async (req: Request, res: Response) => {
  const updatedBy = req.user?.name || req.user?.id || "Admin";

  try {
    const [saved] = await db
      .insert(systemThemes)
      .values({
        id: "default",
        presetName: DEFAULT_THEME_RESPONSE.presetName,
        darkVarsJson: JSON.stringify(DEFAULT_THEME_RESPONSE.dark),
        lightVarsJson: JSON.stringify(DEFAULT_THEME_RESPONSE.light),
        updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemThemes.id,
        set: {
          presetName: DEFAULT_THEME_RESPONSE.presetName,
          darkVarsJson: JSON.stringify(DEFAULT_THEME_RESPONSE.dark),
          lightVarsJson: JSON.stringify(DEFAULT_THEME_RESPONSE.light),
          updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();

    res.json({
      id: saved.id,
      presetName: saved.presetName,
      dark: JSON.parse(saved.darkVarsJson),
      light: JSON.parse(saved.lightVarsJson),
      updatedBy: saved.updatedBy,
      updatedAt: saved.updatedAt,
    });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: "Failed to reset theme", message: error.message });
  }
});
