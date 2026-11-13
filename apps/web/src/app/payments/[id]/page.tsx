import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { PaymentDetailView } from "../../../components/PaymentDetailView";
import { Shell } from "../../../components/Shell";
import type { OverviewData, PaymentData } from "../../../components/types";
import { routes } from "../../../server/api/routes";
import { requireOwner } from "../../../server/page-auth";
export const metadata: Metadata = { title: "Payment" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function PaymentRoute({ params }: { params: Promise<{ id: string }> }): Promise<ReactNode> {
  const { load } = await requireOwner();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [res, overview] = await Promise.all([load<{ payment: PaymentData }>(routes.paymentGet, `/api/payments/${id}`), load<OverviewData>(routes.overview, "/api/overview")]);
  return (
    <Shell businessName={overview.business.name} current="payments">
      <PaymentDetailView payment={res.payment} timezone={overview.business.timezone} />
    </Shell>
  );
}
