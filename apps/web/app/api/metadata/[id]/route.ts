import { getMetadata } from "@preorder/core";

export async function GET(_req: Request, ctx: RouteContext<"/api/metadata/[id]">) {
  const { id } = await ctx.params;
  const meta = getMetadata(id);
  if (!meta) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(meta, { headers: { "Cache-Control": "public, max-age=300" } });
}
