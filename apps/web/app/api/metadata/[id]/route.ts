import { metadataResponse } from "@/lib/server";

export async function GET(_req: Request, ctx: RouteContext<"/api/metadata/[id]">) {
  const { id } = await ctx.params;
  return metadataResponse(id);
}
