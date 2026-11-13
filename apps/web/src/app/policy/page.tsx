import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PolicyForm } from "../../components/PolicyForm";
import { Shell } from "../../components/Shell";
import type { OverviewData, PolicyResponse } from "../../components/types";
import { routes } from "../../server/api/routes";
import { requireOwner } from "../../server/page-auth";
export const metadata: Metadata = { title: "Payment policies" };
export default async function PolicyPage(): Promise<ReactNode> {
  const { deps, load } = await requireOwner();
  const [policy, overview] = await Promise.all([load<PolicyResponse>(routes.policyGet, "/api/policy"), load<OverviewData>(routes.overview, "/api/overview")]);
  const pair = { currency: deps.config.rlusd.currencyHex, issuer: deps.config.rlusd.issuer };
  return (
    <Shell businessName={overview.business.name} current="policy">
      <PolicyForm initial={policy.policy} timezone={policy.timezone} pair={pair} />
    </Shell>
  );
}
