import { UTApi, UTFile } from "uploadthing/server";
import { ConfigError, HttpError, IMAGE_MAX_BYTES, ImageError, detectImageType, saveImage } from "@preorder/core";
import { errorResponse, logLine, publicOrigin, rateLimit, requestLog } from "@/lib/server";

// A maker's product photo: raw image bytes in the body. The type is read from the bytes, never from the
// request's Content-Type. With UPLOADTHING_TOKEN set the photo is stored on UploadThing and its public https
// URL returned, which works from any host. Without it the photo is kept in our store and served from this
// app, which needs the app's public address (PUBLIC_BASE_URL) because the link goes into on-chain metadata.
export async function POST(req: Request) {
  const log = requestLog("POST /api/images");
  try {
    rateLimit(req, "upload", "Too many uploads. Wait a minute and try again.");
    const uploadthing = process.env.UPLOADTHING_TOKEN?.trim();
    const origin = uploadthing ? null : ownOrigin(req);
    const bytes = await readCapped(req);

    if (uploadthing) {
      const mime = detectImageType(bytes);
      if (!mime) throw new HttpError("Use a PNG, JPEG or WebP photo", 400);
      const ext = mime.split("/")[1];
      const { data, error } = await new UTApi({ token: uploadthing }).uploadFiles(new UTFile([bytes], `product-${Date.now()}.${ext}`, { type: mime }));
      if (error || !data) {
        logLine("error", { reqId: log.reqId, route: log.route, err: error?.message ?? "no file returned" });
        throw new HttpError("The photo couldn’t be stored right now. Try again, or paste a link to a photo instead.", 503);
      }
      return Response.json({ url: data.ufsUrl });
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

// Checked before reading the photo, so a refused upload stores nothing.
function ownOrigin(req: Request) {
  try {
    return publicOrigin(req);
  } catch (e) {
    if (e instanceof ConfigError)
      throw new HttpError("Photo uploads need UPLOADTHING_TOKEN, or this app’s public address (PUBLIC_BASE_URL). Or paste a link to a photo instead.", 503);
    throw e;
  }
}

// Reads at most the limit, so a client that lies about (or omits) its length cannot fill memory.
async function readCapped(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > IMAGE_MAX_BYTES) throw new HttpError("That photo is too large", 413);
  if (!req.body) throw new HttpError("Choose a photo to upload", 400);
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
  return bytes;
}
