import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PAYMENT_STATUSES } from "../../components/status-vocab";
import { PaymentsView } from "../../components/PaymentsView";
import { Shell } from "../../components/Shell";
import type { OverviewData, PaymentsPage } from "../../components/types";
import { routes } from "../../server/api/routes";
import { requireOwner } from "../../server/page-auth";
export const metadata: Metadata = { title: "Payments" };
const PAGE = /^[1-9][0-9]{0,3}$/;
export default async function PaymentsRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const { load } = await requireOwner();
  const sp = await searchParams;
  const status = typeof sp.status === "string" && PAYMENT_STATUSES.includes(sp.status) ? sp.status : null;
  const page = typeof sp.page === "string" && PAGE.test(sp.page) ? sp.page : null;
  const query = [status === null ? "" : `status=${status}`, page === null ? "" : `page=${page}`].filter((x) => x !== "").join("&");
  const [list, overview] = await Promise.all([load<PaymentsPage>(routes.paymentsList, `/api/payments${query === "" ? "" : `?${query}`}`), load<OverviewData>(routes.overview, "/api/overview")]);
  return (
    <Shell businessName={overview.business.name} current="payments">
      <PaymentsView page={list} status={status} timezone={overview.business.timezone} />
    </Shell>
  );
}
