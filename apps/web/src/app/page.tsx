import type { Metadata } from "next";
import type { ReactNode } from "react";
import { OverviewView } from "../components/OverviewView";
import { Shell } from "../components/Shell";
import type { OverviewData } from "../components/types";
import { routes } from "../server/api/routes";
import { requireOwner } from "../server/page-auth";
export const metadata: Metadata = { title: "Overview" };
export default async function OverviewPage(): Promise<ReactNode> {
  const { load } = await requireOwner();
  const data = await load<OverviewData>(routes.overview, "/api/overview");
  return (
    <Shell businessName={data.business.name} current="overview">
      <OverviewView data={data} />
    </Shell>
  );
}
