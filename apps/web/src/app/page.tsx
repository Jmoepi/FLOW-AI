import type { Metadata } from "next";
import type { ReactNode } from "react";
import { OverviewView } from "../components/OverviewView";
import { Shell } from "../components/Shell";
import type { OverviewData, PolicyResponse } from "../components/types";
import { routes } from "../server/api/routes";
import { requireOwner } from "../server/page-auth";
export const metadata: Metadata = { title: "Overview" };
export default async function OverviewPage(): Promise<ReactNode> {
  const { load } = await requireOwner();
  const [data, policy] = await Promise.all([load<OverviewData>(routes.overview, "/api/overview"), load<PolicyResponse>(routes.policyGet, "/api/policy")]);
  return (
    <Shell businessName={data.business.name} current="overview">
      <OverviewView data={data} policy={policy.policy} />
    </Shell>
  );
}
