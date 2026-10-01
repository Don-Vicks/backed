import "server-only";
import { createHash, timingSafeEqual } from "crypto";

// Operator routes take `Authorization: Bearer <ADMIN_TOKEN>`. Without ADMIN_TOKEN they are closed, and
// a token shorter than MIN_TOKEN_LENGTH counts as unset: these routes are public and not throttled, so
// the token must not be guessable.
const MIN_TOKEN_LENGTH = 32;
let warned = false;

// "admin" only for `Authorization: Bearer <ADMIN_TOKEN>` with a long enough ADMIN_TOKEN set; "denied"
// when an Authorization header is sent but does not match (or no usable token is set); "none" without one.
export function adminAuth(req: Request): "admin" | "denied" | "none" {
  const header = req.headers.get("authorization");
  if (!header) return "none";
  const token = process.env.ADMIN_TOKEN?.trim() ?? "";
  if (token && token.length < MIN_TOKEN_LENGTH && !warned) {
    warned = true;
    console.warn(`ADMIN_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters, so admin routes stay closed (openssl rand -hex 32)`);
  }
  if (token.length < MIN_TOKEN_LENGTH) return "denied";
  const given = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
  // Compare digests so neither the length nor the content leaks through timing.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given), digest(token)) ? "admin" : "denied";
}

export const isAdmin = (req: Request): boolean => adminAuth(req) === "admin";

export const unauthorized = () => Response.json({ error: "Not authorized" }, { status: 401 });
