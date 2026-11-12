import { z } from "zod";
import { MoneyStringSchema } from "./money";

/** The only network that may execute (spec 10.1). */
export const TESTNET = "xrpl-testnet" as const;

/** (currency hex, issuer) pair. Always compared as a pair (spec 10.2). */
export const AssetPairSchema = z.object({
  currency: z.string().min(1),
  issuer: z.string().min(1),
});
export type AssetPair = z.infer<typeof AssetPairSchema>;

/** `treasury_policies` row (spec 6.2 / 8.1). Supplier approval and timezone are NOT here by design. */
export const TreasuryPolicySchema = z.object({
  enabled: z.boolean(),
  max_payment_amount: MoneyStringSchema,
  daily_spend_limit: MoneyStringSchema,
  minimum_reserve: MoneyStringSchema,
  allowed_assets: z.array(AssetPairSchema),
  /** ISO 8601 instant, or null for no expiry. Unparseable values fail closed (MANDATE_EXPIRED). */
  valid_until: z.string().nullable(),
  version: z.number().int().min(0),
});
export type TreasuryPolicy = z.infer<typeof TreasuryPolicySchema>;
