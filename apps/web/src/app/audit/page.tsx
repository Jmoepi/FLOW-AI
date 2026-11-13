import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuditView } from "../../components/AuditView";
import { Shell } from "../../components/Shell";
import type { AuditPage, OverviewData } from "../../components/types";
import { routes } from "../../server/api/routes";
import { requireOwner } from "../../server/page-auth";
export const metadata: Metadata = { title: "Audit" };
const SEQ = /^[0-9]{1,15}$/;
export default async function AuditPageRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const { load } = await requireOwner();
  const raw = (await searchParams).before_seq;
  const before = typeof raw === "string" && SEQ.test(raw) && Number(raw) > 0 ? raw : null;
  const query = before === null ? "" : `?before_seq=${before}`;
  const [page, overview] = await Promise.all([load<AuditPage>(routes.auditList, `/api/audit-events${query}`), load<OverviewData>(routes.overview, "/api/overview")]);
  return (
    <Shell businessName={overview.business.name} current="audit">
      <AuditView page={page} timezone={overview.business.timezone} />
    </Shell>
  );
}
