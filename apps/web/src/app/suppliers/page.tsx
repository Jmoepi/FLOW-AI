import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "../../components/Shell";
import { SuppliersView } from "../../components/SuppliersView";
import type { OverviewData, SupplierData } from "../../components/types";
import { routes } from "../../server/api/routes";
import { requireOwner } from "../../server/page-auth";
export const metadata: Metadata = { title: "Suppliers" };
export default async function SuppliersPage(): Promise<ReactNode> {
  const { load } = await requireOwner();
  const [list, overview] = await Promise.all([load<{ suppliers: SupplierData[] }>(routes.suppliersList, "/api/suppliers"), load<OverviewData>(routes.overview, "/api/overview")]);
  return (
    <Shell businessName={overview.business.name} current="suppliers">
      <SuppliersView initial={list.suppliers} />
    </Shell>
  );
}
