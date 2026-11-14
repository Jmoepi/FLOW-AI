"use client";
import { useState, type ReactNode } from "react";
import { writeJson } from "./api";
import { Icon } from "./ui/Icon";
export function LogoutButton(): ReactNode {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const onClick = (): void => {
    setBusy(true);
    setFailed(false);
    void writeJson("POST", "/api/auth/logout", {}).then((res) => {
      if (res.status === 200 || res.status === 401) window.location.assign("/login");
      else {
        setBusy(false);
        setFailed(true);
      }
    });
  };
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClick} disabled={busy}>
        <Icon name="lock" />
        Sign out
      </button>
      {failed ? <span role="alert">Could not sign out. Try again.</span> : null}
    </>
  );
}
