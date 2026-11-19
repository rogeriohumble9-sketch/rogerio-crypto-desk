import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const ACCESS_COOKIE = "desk_access";

export function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function digestHex(token: string): string {
  return tokenDigest(token).toString("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function hasAccessCookie(header: string | undefined, token: string): boolean {
  const value = cookieValue(header, ACCESS_COOKIE);
  if (!value) return false;
  return safeEqual(value, digestHex(token));
}

export function queryTokenMatches(token: string | null, expected: string): boolean {
  if (!token) return false;
  return safeEqual(token, expected);
}

export function requestIsHttps(req: IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return first?.split(",")[0]?.trim() === "https";
}

export function accessCookie(token: string, secure: boolean): string {
  const parts = [
    `${ACCESS_COOKIE}=${digestHex(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
