import type { Route } from "../http/route";
import { agentRunRequestRoute, agentRunsListRoute } from "./agent-runs";
import { auditListRoute } from "./audit";
import { healthzRoute, readyzRoute } from "./health";
import { invoiceGetRoute, invoicesListRoute } from "./invoices";
import { loginRoute, logoutRoute, sessionRoute } from "./auth";
import { overviewRoute } from "./overview";
import { paymentGetRoute, paymentsListRoute } from "./payments";
import { policyGetRoute, policyPutRoute } from "./policy";
import { supplierPatchRoute, suppliersListRoute } from "./suppliers";
/**
 * The route table (AZ-1). Every HTTP endpoint is listed here with its declared role; the thin Next route files under
 * src/app/api only re-export entries of this table, and a test enumerates both so none can be added silently.
 */
export const routes = {
  login: loginRoute,
  logout: logoutRoute,
  session: sessionRoute,
  policyGet: policyGetRoute,
  policyPut: policyPutRoute,
  suppliersList: suppliersListRoute,
  supplierPatch: supplierPatchRoute,
  auditList: auditListRoute,
  agentRunsList: agentRunsListRoute,
  overview: overviewRoute,
  agentRunRequest: agentRunRequestRoute,
  invoicesList: invoicesListRoute,
  invoiceGet: invoiceGetRoute,
  paymentsList: paymentsListRoute,
  paymentGet: paymentGetRoute,
  healthz: healthzRoute,
  readyz: readyzRoute,
} as const satisfies Record<string, Route>;
export const routeList: readonly Route[] = Object.values(routes);
