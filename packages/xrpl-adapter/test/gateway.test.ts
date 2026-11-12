import { describe, expect, it } from "vitest";
import { ALLOWED_TESTNET_WS_URLS, MAINNET_RLUSD_ISSUER, assertAllowedTestnetUrl, assertTestnetAsset, assertTestnetConfig } from "../src/index";

const GOOD = "wss://s.altnet.rippletest.net:51233";
const TESTNET_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const HEX = "524C555344000000000000000000000000000000";

describe("Testnet endpoint allowlist (exact match)", () => {
  it("accepts exactly the known Testnet WSS endpoint", () => {
    expect(ALLOWED_TESTNET_WS_URLS).toContain(GOOD);
    expect(() => assertTestnetConfig("xrpl-testnet", GOOD)).not.toThrow();
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["trailing slash", GOOD + "/"],
    ["path", GOOD + "/testnet"],
    ["query", GOOD + "?testnet=1"],
    ["fragment", GOOD + "#testnet"],
    ["plain ws", "ws://s.altnet.rippletest.net:51233"],
    ["https", "https://s.altnet.rippletest.net:51233"],
    ["wrong port", "wss://s.altnet.rippletest.net:443"],
    ["no port", "wss://s.altnet.rippletest.net"],
    ["userinfo", "wss://user:pw@s.altnet.rippletest.net:51233"],
    ["userinfo host confusion", "wss://s.altnet.rippletest.net:51233@evil.example"],
    ["uppercase host", "wss://S.ALTNET.RIPPLETEST.NET:51233"],
    ["leading space", " " + GOOD],
    ["trailing space", GOOD + " "],
    ["suffix host", "wss://s.altnet.rippletest.net.evil.example:51233"],
    ["word testnet in host", "wss://testnet.evil.example"],
    ["word testnet in path", "wss://evil.example/testnet"],
    ["mainnet cluster", "wss://xrplcluster.com"],
    ["ripple mainnet", "wss://s1.ripple.com"],
    ["devnet", "wss://s.devnet.rippletest.net:51233"],
  ])("rejects %s", (_n, url) => {
    expect(() => assertTestnetConfig("xrpl-testnet", url)).toThrow(/allowlist/);
  });

  it("does not echo the rejected URL (it may carry credentials)", () => {
    try {
      assertAllowedTestnetUrl("wss://user:topsecretpw@evil.example");
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("topsecretpw");
    }
  });

  it("requires the network name exactly", () => {
    for (const n of [undefined, "", "xrpl-mainnet", "XRPL-TESTNET", "xrpl-testnet ", "testnet"]) {
      expect(() => assertTestnetConfig(n, GOOD)).toThrow(/XRPL_NETWORK/);
    }
  });
});

describe("assertTestnetAsset", () => {
  it("accepts the Testnet issuer and currency", () => {
    expect(() => assertTestnetAsset(TESTNET_ISSUER, HEX)).not.toThrow();
  });
  it("rejects the Mainnet RLUSD issuer", () => {
    expect(() => assertTestnetAsset(MAINNET_RLUSD_ISSUER, HEX)).toThrow(/Mainnet/);
  });
  it("rejects missing or malformed issuers and currencies", () => {
    expect(() => assertTestnetAsset(undefined, HEX)).toThrow();
    expect(() => assertTestnetAsset("rNotAValidAddress", HEX)).toThrow();
    expect(() => assertTestnetAsset(TESTNET_ISSUER, undefined)).toThrow();
    expect(() => assertTestnetAsset(TESTNET_ISSUER, "rlusd")).toThrow();
    expect(() => assertTestnetAsset(TESTNET_ISSUER, HEX.toLowerCase())).toThrow();
    expect(() => assertTestnetAsset(TESTNET_ISSUER, HEX + "00")).toThrow();
  });
});
