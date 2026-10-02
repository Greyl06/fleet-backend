import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { roles, permissions, rolePermissions } from '../db/schema.js';

export const rolesRouter = Router();

// GET /api/roles - List all roles with their assigned permission keys
rolesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const allRoles = await db.select().from(roles);
    const allMappings = await db.select().from(rolePermissions);

    const rolesWithPermissions = allRoles.map((r) => {
      const assigned = allMappings
        .filter((m) => m.roleId === r.id)
        .map((m) => m.permissionKey);
      return {
        ...r,
        permissions: assigned,
      };
    });

    res.json(rolesWithPermissions);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// GET /api/roles/permissions - List all available permissions
rolesRouter.get('/permissions', async (_req: Request, res: Response) => {
  try {
    const allPerms = await db.select().from(permissions);
    res.json(allPerms);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// POST /api/roles/permissions - Create a custom dynamic permission
rolesRouter.post('/permissions', async (req: Request, res: Response) => {
  try {
    const { key, label, description, group } = req.body;
    if (!key || !label) {
      res.status(400).json({ error: 'key and label are required' });
      return;
    }
    const [created] = await db.insert(permissions).values({
      key,
      label,
      description: description || '',
      moduleGroup: group || 'Custom',
    }).returning();
    res.status(201).json(created);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/roles/permissions/:key - Update a permission
rolesRouter.put('/permissions/:key', async (req: Request, res: Response) => {
  try {
    const { label, group } = req.body;
    const [updated] = await db.update(permissions).set({
      label,
      moduleGroup: group,
    }).where(eq(permissions.key, String(req.params.key))).returning();

    if (!updated) {
      res.status(404).json({ error: 'Permission not found' });
      return;
    }
    res.json(updated);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/roles/permissions/:key - Delete a permission
rolesRouter.delete('/permissions/:key', async (req: Request, res: Response) => {
  try {
    const permKey = String(req.params.key);
    await db.delete(rolePermissions).where(eq(rolePermissions.permissionKey, permKey));
    await db.delete(permissions).where(eq(permissions.key, permKey));
    res.json({ message: 'Permission deleted', key: permKey });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// POST /api/roles - Create custom role
rolesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { key, label, description, color, permissions: permKeys } = req.body;
    if (!key || !label) {
      res.status(400).json({ error: 'key and label are required' });
      return;
    }

    const [created] = await db.insert(roles).values({
      key,
      label,
      description: description || '',
      color: color || '#6366f1',
      isSystem: false,
    }).returning();

    if (Array.isArray(permKeys) && permKeys.length > 0) {
      await db.insert(rolePermissions).values(
        permKeys.map((pKey: string) => ({
          roleId: created.id,
          permissionKey: pKey,
        }))
      );
    }

    res.status(201).json({ ...created, permissions: permKeys || [] });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/roles/:id - Update role metadata and permissions
rolesRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const { label, description, color, permissions: permKeys } = req.body;
    const [updated] = await db.update(roles).set({
      label,
      description,
      color,
      updatedAt: new Date(),
    }).where(eq(roles.id, String(req.params.id))).returning();

    if (!updated) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }

    if (Array.isArray(permKeys)) {
      // Replace permissions mapping
      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, updated.id));
      if (permKeys.length > 0) {
        await db.insert(rolePermissions).values(
          permKeys.map((pKey: string) => ({
            roleId: updated.id,
            permissionKey: pKey,
          }))
        );
      }
    }

    res.json({ ...updated, permissions: permKeys || [] });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/roles/:id - Delete custom role (system roles cannot be deleted)
rolesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const [target] = await db.select().from(roles).where(eq(roles.id, String(req.params.id)));
    if (!target) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }
    if (target.isSystem) {
      res.status(403).json({ error: 'System roles cannot be deleted' });
      return;
    }

    await db.delete(roles).where(eq(roles.id, String(req.params.id)));
    res.json({ message: 'Role deleted successfully', id: String(req.params.id) });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});
