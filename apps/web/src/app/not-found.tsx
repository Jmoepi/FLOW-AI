import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "Not found" };
export default function NotFound(): ReactNode {
  return (
    <main id="main" tabIndex={-1}>
      <h1>Page not found</h1>
      <p>We could not find that page, or it is not part of your business.</p>
      <p>
        <a href="/">Go to Overview</a>
      </p>
    </main>
  );
}
