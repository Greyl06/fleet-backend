import { Request, Response, NextFunction } from 'express';
import { AuthUser, defineAbilityFor, Action, Subject, Role } from '../auth/abilities.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      ability?: ReturnType<typeof defineAbilityFor>;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Support simulated header-based authentication for dev/testing/APIs
  const role = (req.headers['x-user-role'] as Role) || 'admin';
  const userId = (req.headers['x-user-id'] as string) || 'system-user-1';
  const name = (req.headers['x-user-name'] as string) || 'Fleet Admin';
  const department = (req.headers['x-user-department'] as string) || 'Logistics';

  req.user = {
    id: userId,
    name,
    role,
    department,
  };
  req.ability = defineAbilityFor(req.user);
  next();
}

export function requirePermission(action: Action, subject: Subject) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.ability || !req.ability.can(action, subject)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Current role '${req.user?.role}' does not have permission to ${action} ${subject}.`,
      });
      return;
    }
    next();
  };
}
