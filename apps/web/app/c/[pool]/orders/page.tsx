import type { Metadata } from "next";
import { BRAND } from "@preorder/core/src/brand";
import { OrdersView } from "./orders-view";

export const metadata: Metadata = { title: `Orders · ${BRAND}` };

export default async function OrdersPage({ params }: PageProps<"/c/[pool]/orders">) {
  const { pool } = await params;
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <OrdersView pool={pool} />
    </div>
  );
}
