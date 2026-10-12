import { Router, Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, localCredentials } from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";

export const userRouter = Router();

userRouter.get(
  "/drivers",
  requirePermission("read", "Vehicle"),
  async (_req: Request, res: Response) => {
    try {
      const list = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.role, "driver"), eq(users.status, "active")))
        .orderBy(asc(users.name));
      res.json(list);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

userRouter.use(requirePermission("manage", "all"));

// GET /api/users - List all users
userRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const list = await db.select().from(users);
    const credentials = await db.select({ userId: localCredentials.userId }).from(localCredentials);
    const localUsers = new Set(credentials.map((credential) => credential.userId));
    res.json(list.map((user) => ({ ...user, hasLocalPassword: localUsers.has(user.id) })));
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// POST /api/users - Create new user
userRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { name, email, role, department, status } = req.body;
    if (!name || !email) {
      res.status(400).json({ error: "name and email are required" });
      return;
    }

    const [created] = await db
      .insert(users)
      .values({
        name,
        email,
        role: role || "driver",
        department: department || "Fleet Operations",
        status: status || "active",
        lastActive: new Date(),
      })
      .returning();

    res.status(201).json(created);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/users/:id - Update user
userRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const { name, email, role, department, status } = req.body;
    const [updated] = await db
      .update(users)
      .set({
        name,
        email,
        role,
        department,
        status,
        updatedAt: new Date(),
      })
      .where(eq(users.id, String(req.params.id)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(updated);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/users/:id - Delete user
userRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    await db.delete(users).where(eq(users.id, String(req.params.id)));
    res.json({
      message: "User deleted successfully",
      id: String(req.params.id),
    });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});
