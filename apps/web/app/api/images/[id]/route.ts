import { getImage } from "@preorder/core";

// Product photos are content-addressed (the id is a hash of the bytes), so they never change.
export async function GET(_req: Request, ctx: RouteContext<"/api/images/[id]">) {
  const { id } = await ctx.params;
  const image = getImage(id);
  if (!image) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      // Only ever a picture: no sniffing it into something else, and nothing it contains may run.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // Wallets and explorers load token images from other sites.
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
