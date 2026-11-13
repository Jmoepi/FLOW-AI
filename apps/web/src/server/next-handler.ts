import "server-only";
import { redactError } from "@flow-ai/contracts";
import { getDeps } from "./db";
import { jsonResponse } from "./http/errors";
import type { Route } from "./http/route";
export interface RouteContext {
  params: Promise<Record<string, string | string[] | undefined>>;
}
/** Adapts a framework-agnostic Route to a Next.js route handler. The app refuses to serve when startup checks fail. */
export function handle(route: Route): (request: Request, context: RouteContext) => Promise<Response> {
  return async (request, context) => {
    let deps;
    try {
      deps = await getDeps();
    } catch (err) {
      process.stderr.write(`${JSON.stringify({ level: "error", event: "startup.failed", message: redactError(err) })}\n`);
      return jsonResponse(503, { code: "UNAVAILABLE", message: "The service is not available." });
    }
    return route.run(deps, request, await context.params);
  };
}
