import { ConfigError, HttpError, IMAGE_MAX_BYTES, ImageError, saveImage } from "@preorder/core";
import { errorResponse, publicOrigin, rateLimit, requestLog } from "@/lib/server";

// A maker's product photo: raw image bytes in the body. The type is read from the bytes, never from the
// request's Content-Type. The returned URL is on this app, so the campaign points at something we serve.
export async function POST(req: Request) {
  const log = requestLog("POST /api/images");
  try {
    rateLimit(req, "upload", "Too many uploads. Wait a minute and try again.");
    let origin: string;
    try {
      origin = publicOrigin(req);
    } catch (e) {
      // A photo's link goes into on-chain metadata, so it must be the app's public https address.
      if (e instanceof ConfigError) throw new HttpError("Photo uploads need this app’s public address (PUBLIC_BASE_URL). Set it to the app’s https URL, or paste a link to a photo instead.", 503);
      throw e;
    }
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > IMAGE_MAX_BYTES) throw new HttpError("That photo is too large", 413);
    if (!req.body) throw new HttpError("Choose a photo to upload", 400);

    // Read at most the limit, so a client that lies about (or omits) its length cannot fill memory.
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > IMAGE_MAX_BYTES) {
        await reader.cancel();
        throw new HttpError("That photo is too large", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }

    let id: string;
    try {
      id = saveImage(bytes);
    } catch (e) {
      if (e instanceof ImageError) throw new HttpError(e.message, 400); // the maker can fix this one
      throw e; // a database or other failure: errorResponse logs it and answers with a generic 500
    }
    return Response.json({ url: `${origin}/api/images/${id}` });
  } catch (e) {
    return errorResponse(e, log);
  }
}
