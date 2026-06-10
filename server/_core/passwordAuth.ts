/**
 * Standalone password-based authentication.
 *
 * POST /api/auth/login  — checks APP_PASSWORD, issues a signed JWT session cookie.
 * POST /api/auth/logout — clears the session cookie (also handled via tRPC).
 *
 * The JWT is signed with JWT_SECRET (same key used by the rest of the app).
 * No Manus SDK or external OAuth service is involved.
 */
import { SignJWT, jwtVerify } from "jose";
import type { Express, Request, Response } from "express";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./cookies";

const FIXED_OPEN_ID = "password-auth-user";
const FIXED_APP_ID = "flightdrama";

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is not set");
  return new TextEncoder().encode(secret);
}

export async function createPasswordSessionToken(): Promise<string> {
  const secret = getJwtSecret();
  return new SignJWT({
    openId: FIXED_OPEN_ID,
    appId: FIXED_APP_ID,
    name: "Admin",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("365d")
    .sign(secret);
}

export async function verifyPasswordSession(
  token: string | undefined
): Promise<{ openId: string; appId: string; name: string } | null> {
  if (!token) return null;
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const { openId, appId, name } = payload as Record<string, unknown>;
    if (
      typeof openId !== "string" ||
      typeof appId !== "string" ||
      typeof name !== "string"
    ) {
      return null;
    }
    return { openId, appId, name };
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader) return map;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    map.set(part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim()));
  }
  return map;
}

export async function authenticatePasswordRequest(req: Request): Promise<{
  openId: string;
  appId: string;
  name: string;
} | null> {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.get(COOKIE_NAME);
  return verifyPasswordSession(token);
}

export function registerPasswordAuthRoutes(app: Express) {
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { password } = req.body as { password?: string };
    const appPassword = process.env.APP_PASSWORD;

    if (!appPassword) {
      console.error("[Auth] APP_PASSWORD environment variable is not set");
      res.status(500).json({ error: "Server misconfiguration: APP_PASSWORD not set" });
      return;
    }

    if (!password || password !== appPassword) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    try {
      const token = await createPasswordSessionToken();
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.json({ success: true });
    } catch (error) {
      console.error("[Auth] Failed to create session token", error);
      res.status(500).json({ error: "Failed to create session" });
    }
  });
}
