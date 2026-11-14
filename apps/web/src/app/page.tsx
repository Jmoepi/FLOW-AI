import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Landing } from "../components/Landing";
import { OverviewView } from "../components/OverviewView";
import { Shell } from "../components/Shell";
import type { OverviewData, PolicyResponse } from "../components/types";
import { routes } from "../server/api/routes";
import { isLoggedOut, requireOwner } from "../server/page-auth";
export async function generateMetadata(): Promise<Metadata> {
  return (await isLoggedOut()) ? { title: { absolute: "Flow AI | Limits you can prove" } } : { title: "Overview" };
}
/** Logged-out visitors see the public landing page; any session goes through the owner gate exactly as before. */
export default async function OverviewPage(): Promise<ReactNode> {
  if (await isLoggedOut()) return <Landing />;
  const { load } = await requireOwner();
  const [data, policy] = await Promise.all([load<OverviewData>(routes.overview, "/api/overview"), load<PolicyResponse>(routes.policyGet, "/api/policy")]);
  return (
    <Shell businessName={data.business.name} current="overview">
      <OverviewView data={data} policy={policy.policy} />
    </Shell>
  );
}
