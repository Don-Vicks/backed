import "server-only";
import { createHash, timingSafeEqual } from "crypto";

// Operator routes take `Authorization: Bearer <ADMIN_TOKEN>`. Without ADMIN_TOKEN they are closed, and
// a token shorter than MIN_TOKEN_LENGTH counts as unset: these routes are public and not throttled.
const MIN_TOKEN_LENGTH = 32;
let warned = false;

export function isAdmin(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) return false;
  if (token.length < MIN_TOKEN_LENGTH) {
    if (!warned) {
      warned = true;
      console.warn(`ADMIN_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters, so admin routes stay closed (openssl rand -base64 32)`);
    }
    return false;
  }
  const given = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
  // Compare digests so neither the length nor the content leaks through timing.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given), digest(token));
}

export const unauthorized = () => Response.json({ error: "Not authorized" }, { status: 401 });
