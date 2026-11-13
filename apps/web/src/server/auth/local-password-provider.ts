import { findCredentialByEmail, recordLoginFailure, resetLoginFailures, updatePasswordHash, type Pool } from "@flow-ai/database";
import { DEFAULT_PARAMS, dummyHash, hashPassword, needsRehash, verifyPassword, type ScryptParams } from "./password";
import type { AuthProvider } from "./provider";
/** Account lock: from the 5th consecutive failure, 30 s, doubling per further failure, capped at 15 minutes. */
export const LOCK_POLICY = { threshold: 5, baseSeconds: 30, maxSeconds: 900 } as const;
export interface LocalProviderDeps {
  pool: Pool;
  now: () => Date;
  params?: ScryptParams;
}
/**
 * First AuthProvider (local scrypt credentials in web_credentials). Every failure path does one scrypt verification so
 * unknown email, wrong password and a locked account cost the same and return the same null.
 */
export function createLocalPasswordProvider(deps: LocalProviderDeps): AuthProvider {
  const params = deps.params ?? DEFAULT_PARAMS;
  return {
    async authenticate(email, password) {
      const cred = await findCredentialByEmail(deps.pool, email).catch(() => null);
      if (cred === null) {
        await verifyPassword(password, await dummyHash(params));
        return null;
      }
      const now = deps.now();
      const ok = await verifyPassword(password, cred.password_hash);
      const locked = cred.locked_until !== null && Date.parse(cred.locked_until) > now.getTime();
      if (locked) return null; // correct or not, a locked account does not log in and the counter is not advanced
      if (!ok) {
        await recordLoginFailure(deps.pool, cred.user_id, now, LOCK_POLICY);
        return null;
      }
      await resetLoginFailures(deps.pool, cred.user_id);
      if (needsRehash(cred.password_hash, params)) await updatePasswordHash(deps.pool, cred.user_id, await hashPassword(password, params));
      return { userId: cred.user_id };
    },
  };
}
