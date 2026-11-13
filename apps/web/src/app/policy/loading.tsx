import type { ReactNode } from "react";
import { LoadingSkeleton } from "../../components/States";
export default function Loading(): ReactNode {
  return (
    <main id="main" tabIndex={-1}>
      <LoadingSkeleton label="Loading policy" />
    </main>
  );
}
