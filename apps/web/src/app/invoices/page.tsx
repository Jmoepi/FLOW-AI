import type { Metadata } from "next";
import type { ReactNode } from "react";
import { INVOICE_STATUSES } from "../../components/status-vocab";
import { InvoicesView } from "../../components/InvoicesView";
import { Shell } from "../../components/Shell";
import type { InvoicesPage, OverviewData } from "../../components/types";
import { routes } from "../../server/api/routes";
import { requireOwner } from "../../server/page-auth";
export const metadata: Metadata = { title: "Invoices" };
const PAGE = /^[1-9][0-9]{0,3}$/;
export default async function InvoicesRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const { load } = await requireOwner();
  const sp = await searchParams;
  // Only known values reach the API: anything else is ignored, never forwarded.
  const status = typeof sp.status === "string" && INVOICE_STATUSES.includes(sp.status) ? sp.status : null;
  const page = typeof sp.page === "string" && PAGE.test(sp.page) ? sp.page : null;
  const query = [status === null ? "" : `status=${status}`, page === null ? "" : `page=${page}`].filter((x) => x !== "").join("&");
  const [list, overview] = await Promise.all([load<InvoicesPage>(routes.invoicesList, `/api/invoices${query === "" ? "" : `?${query}`}`), load<OverviewData>(routes.overview, "/api/overview")]);
  return (
    <Shell businessName={overview.business.name} current="invoices">
      <InvoicesView page={list} status={status} today={overview.today.business_date} />
    </Shell>
  );
}
