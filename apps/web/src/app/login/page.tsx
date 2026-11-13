import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LoginForm } from "../../components/LoginForm";
import { PublicShell } from "../../components/Shell";
export const metadata: Metadata = { title: "Sign in" };
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const params = await searchParams;
  return (
    <PublicShell>
      <LoginForm reauth={params.reauth === "1"} />
    </PublicShell>
  );
}
