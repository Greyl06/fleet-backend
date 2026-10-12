import { z } from "zod";

export function createAdminPasswordSchema(zod: typeof import("zod").z) {
  return zod.object({ userId: zod.string().uuid(), password: zod.string().min(12).max(256) }).strict();
}
export const adminPasswordSchema = createAdminPasswordSchema(z);