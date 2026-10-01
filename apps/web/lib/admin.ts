import "server-only";
import { createHash, timingSafeEqual } from "crypto";

// Operator routes take `Authorization: Bearer <ADMIN_TOKEN>`. Without ADMIN_TOKEN they are closed.
export function isAdmin(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) return false;
  const given = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
  // Compare digests so neither the length nor the content leaks through timing.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given), digest(token));
}

export const unauthorized = () => Response.json({ error: "Not authorized" }, { status: 401 });
