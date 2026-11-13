/** Next.js startup hook. Starts the housekeeping job in the Node.js server process only (never on the edge or in the browser). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startHousekeeping } = await import("./server/housekeeping");
  const { getDeps } = await import("./server/db");
  startHousekeeping(getDeps, (message) => console.error(JSON.stringify({ level: "error", event: "housekeeping.failed", message })));
}
