import { routes } from "../../../../server/api/routes";
import { handle } from "../../../../server/next-handler";

// Thin adapter: all logic, authorization and validation live in src/server (see the route table).
export const dynamic = "force-dynamic";
export const POST = handle(routes.logout);
