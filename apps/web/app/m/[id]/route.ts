import { metadataResponse } from "@/lib/server";

// Short token-metadata URL (Metaplex uri) for new campaigns; /api/metadata/<id> serves older ones.
export async function GET(_req: Request, ctx: RouteContext<"/m/[id]">) {
  const { id } = await ctx.params;
  return metadataResponse(id);
}
