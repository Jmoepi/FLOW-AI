import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AgentActivityView } from "../../components/AgentActivityView";
import { Shell } from "../../components/Shell";
import type { AgentRunsPage, OverviewData } from "../../components/types";
import { routes } from "../../server/api/routes";
import { requireOwner } from "../../server/page-auth";
export const metadata: Metadata = { title: "Agent activity" };
const SEQ = /^[0-9]{1,15}$/;
export default async function AgentPageRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const { load } = await requireOwner();
  const raw = (await searchParams).before_seq;
  const before = typeof raw === "string" && SEQ.test(raw) && Number(raw) > 0 ? raw : null;
  const query = before === null ? "" : `?before_seq=${before}`;
  const [page, overview] = await Promise.all([load<AgentRunsPage>(routes.agentRunsList, `/api/agent-runs${query}`), load<OverviewData>(routes.overview, "/api/overview")]);
  return (
    <Shell businessName={overview.business.name} current="agent">
      <AgentActivityView page={page} timezone={overview.business.timezone} />
    </Shell>
  );
}
