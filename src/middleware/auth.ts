import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  type Action,
  defineAbilityFor,
  type Role,
  type Subject,
} from "../auth/abilities.js";
import { config } from "../config/env.js";
import {
  authenticateEntraToken,
  authenticateLocalSession,
  tokenHash,
} from "../services/auth.service.js";

declare global {
  namespace Express {
    interface Request {
      user?: import("../auth/abilities.js").AuthUser;
      ability?: ReturnType<typeof defineAbilityFor>;
      authMethod?: "entra" | "local" | "development";
      authSessionId?: string;
      authCsrfTokenHash?: string;
    }
  }
}

function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  const part = header
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : undefined;
}

function isPublicRequest(req: Request): boolean {
  if (
    req.path === "/api/health" ||
    req.path.startsWith("/api/forms/published/")
  )
    return true;
  if (req.method === "GET" && req.path === "/api/auth/signup/options")
    return true;
  return (
    req.method === "POST" &&
    [
      "/api/auth/local/login",
      "/api/auth/local/signup",
      "/api/auth/local/signup/verify",
      "/api/auth/local/password-reset/request",
      "/api/auth/local/password-reset/consume",
    ].includes(req.path)
  );
}

function csrfIsValid(req: Request, expectedHash: string): boolean {
  const csrfCookie = cookieValue(req.headers.cookie, "fleet_csrf");
  const csrfHeader = req.headers["x-csrf-token"];
  if (!csrfCookie || typeof csrfHeader !== "string") return false;
  const cookieBytes = Buffer.from(csrfCookie);
  const headerBytes = Buffer.from(csrfHeader);
  if (
    cookieBytes.length !== headerBytes.length ||
    !timingSafeEqual(cookieBytes, headerBytes)
  )
    return false;
  const expected = Buffer.from(expectedHash);
  const supplied = Buffer.from(tokenHash(csrfHeader));
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (isPublicRequest(req)) {
      next();
      return;
    }

    const authorization = req.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      const principal = await authenticateEntraToken(authorization.slice(7));
      if (!principal) {
        res
          .status(401)
          .json({
            error: "Unauthorized",
            message: "Invalid or unlinked Entra identity.",
          });
        return;
      }
      req.user = principal.user;
      req.authMethod = principal.authMethod;
      req.ability = defineAbilityFor(principal.user);
      next();
      return;
    }

    const sessionToken = cookieValue(req.headers.cookie, "fleet_session");
    if (sessionToken) {
      const principal = await authenticateLocalSession(sessionToken);
      if (!principal) {
        res
          .status(401)
          .json({
            error: "Unauthorized",
            message: "Fleet session is invalid or expired.",
          });
        return;
      }
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        !csrfIsValid(req, principal.csrfTokenHash ?? "")
      ) {
        res
          .status(403)
          .json({ error: "Forbidden", message: "CSRF validation failed." });
        return;
      }
      req.user = principal.user;
      req.authMethod = principal.authMethod;
      req.authSessionId = principal.sessionId;
      req.authCsrfTokenHash = principal.csrfTokenHash;
      req.ability = defineAbilityFor(principal.user);
      next();
      return;
    }

    if (config.allowDevHeaderAuth) {
      const requestedRole = req.headers["x-user-role"] as string | undefined;
      const role =
        (requestedRole as Role | undefined) ??
        (config.env === "test" ? "admin" : undefined);
      if (role) {
        const validRoles = new Set<Role>([
          "admin",
          "fleet_team",
          "procurement",
          "finance",
          "approver",
          "department_requester",
          "driver",
        ]);
        if (!validRoles.has(role)) {
          res
            .status(401)
            .json({
              error: "Unauthorized",
              message: "Unknown development role.",
            });
          return;
        }
        req.user = {
          id: (req.headers["x-user-id"] as string | undefined) ?? "test-user",
          name:
            (req.headers["x-user-name"] as string | undefined) ?? "Test User",
          role,
          department: req.headers["x-user-department"] as string | undefined,
        };
        req.authMethod = "development";
        req.ability = defineAbilityFor(req.user);
        next();
        return;
      }
    }

    res
      .status(401)
      .json({ error: "Unauthorized", message: "Authentication required." });
  } catch {
    res
      .status(401)
      .json({
        error: "Unauthorized",
        message: "Authentication could not be verified.",
      });
  }
}

export function requirePermission(action: Action, subject: Subject) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.ability || !req.ability.can(action, subject)) {
      res.status(403).json({
        error: "Forbidden",
        message: `Current role '${req.user?.role}' does not have permission to ${action} ${subject}.`,
      });
      return;
    }
    next();
  };
}
