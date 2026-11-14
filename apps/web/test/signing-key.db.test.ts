import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertSnapshot } from "@flow-ai/database";
import { attemptWalletModeUpdateAll, setWalletSigningKeyModeAs } from "@flow-ai/database/testing";
import { routes } from "../src/server/api/routes";
import { createWebHarness, type Session, type WebHarness } from "./helpers";

let h: WebHarness;
let owner: Session;
beforeAll(async () => {
  h = await createWebHarness();
  owner = await h.login(h.owner);
});
afterAll(async () => {
  await h.close();
});

const signingKey = async (): Promise<unknown> => (await h.authed(routes.overview, owner)).body?.signing_key;
const snapshot = (state: "active" | "not_set" | "other" | "not_configured") =>
  insertSnapshot(h.db.guardPool, { wallet_id: h.scenario.walletId, rlusd_balance: "100", xrp_balance: "100", ledger_index: 1000, regular_key_state: state });

describe("owner overview: guard signing key status (M7, read-only under flow_web)", () => {
  it("is unknown before the guard reports anything", async () => {
    expect(await signingKey()).toEqual({ state: "unknown" });
  });
  it("shows the observed RegularKey state written by the guard poller", async () => {
    await snapshot("not_set");
    expect(await signingKey()).toEqual({ state: "not_set" });
    await snapshot("active");
    expect(await signingKey()).toEqual({ state: "active" });
    await snapshot("other");
    expect(await signingKey()).toEqual({ state: "other" });
  });
  it("shows revoked once the guard persisted the revoked mode, regardless of snapshots", async () => {
    await setWalletSigningKeyModeAs(h.db.guardPool, h.scenario.walletId, "regular_key");
    await setWalletSigningKeyModeAs(h.db.guardPool, h.scenario.walletId, "revoked");
    await snapshot("active");
    expect(await signingKey()).toEqual({ state: "revoked" });
  });
  it("the web role can read but never change the signing key mode, and holds no seed", async () => {
    await expect(attemptWalletModeUpdateAll(h.db.webPool, "regular_key")).rejects.toThrow(/permission denied/);
    const body = JSON.stringify((await h.authed(routes.overview, owner)).body);
    expect(body).not.toMatch(/\bs[1-9A-HJ-NP-Za-km-z]{25,34}\b/);
  });
});
