import { randomUUID } from "node:crypto";
/** Always generated here. A client-supplied id is never trusted or echoed (it would let a caller forge audit correlation). */
export function newRequestId(): string {
  return randomUUID();
}
