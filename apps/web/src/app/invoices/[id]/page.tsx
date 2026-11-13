import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { InvoiceDetailView } from "../../../components/InvoiceDetailView";
import { Shell } from "../../../components/Shell";
import type { InvoiceData, OverviewData } from "../../../components/types";
import { routes } from "../../../server/api/routes";
import { requireOwner } from "../../../server/page-auth";
export const metadata: Metadata = { title: "Invoice" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function InvoiceRoute({ params }: { params: Promise<{ id: string }> }): Promise<ReactNode> {
  const { load } = await requireOwner();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [res, overview] = await Promise.all([load<{ invoice: InvoiceData }>(routes.invoiceGet, `/api/invoices/${id}`), load<OverviewData>(routes.overview, "/api/overview")]);
  return (
    <Shell businessName={overview.business.name} current="invoices">
      <InvoiceDetailView invoice={res.invoice} today={overview.today.business_date} />
    </Shell>
  );
}
