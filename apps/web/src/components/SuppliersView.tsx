"use client";
import { useState, type ReactNode } from "react";
import { StatusBadge } from "./Badge";
import { str, writeJson } from "./api";
import { shortAddress } from "./format";
import type { SupplierData } from "./types";
/**
 * Supplier names and addresses are untrusted text: they are only ever rendered as React text children, never as markup,
 * and no link or attribute is built from them (WB-1).
 */
export function SuppliersView({ initial }: { initial: SupplierData[] }): ReactNode {
  const [suppliers, setSuppliers] = useState<SupplierData[]>(initial);
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const patch = (s: SupplierData, change: { is_approved?: boolean; is_active?: boolean }, done: string): void => {
    setBusyId(s.id);
    setStatus("Saving…");
    void writeJson("PATCH", `/api/suppliers/${encodeURIComponent(s.id)}`, change).then((res) => {
      setBusyId(null);
      const row = res.body.supplier;
      if (res.status === 200 && typeof row === "object" && row !== null) {
        const next = row as SupplierData;
        setSuppliers((list) => list.map((x) => (x.id === next.id ? { ...x, is_approved: next.is_approved, is_active: next.is_active, updated_at: next.updated_at } : x)));
        setStatus(`${s.name}: ${done}`);
      } else if (res.status === 401 && str(res.body.code) === "REAUTH_REQUIRED") {
        setStatus(`${s.name}: sign in again before approving a supplier. Nothing was changed.`);
      } else {
        setStatus(`${s.name}: the change could not be saved. Nothing was changed.`);
      }
    });
  };
  const copy = (s: SupplierData): void => {
    navigator.clipboard.writeText(s.xrpl_address).then(
      () => setStatus(`Copied the XRPL address for ${s.name}.`),
      () => setStatus(`Could not copy the address for ${s.name}.`),
    );
  };
  return (
    <>
      <h1>Suppliers</h1>
      <p className="lede">The agent can only request payment to suppliers you have approved. Names and addresses are read-only here.</p>
      <p className="guard-note">Approving allows the agent to request payment to this address within your other limits. Removing approval takes effect on the next payment request.</p>
      {suppliers.length === 0 ? (
        <p className="empty-state">No suppliers yet.</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Suppliers and their approval status" tabIndex={0}>
        <table className="table">
          <caption className="sr-only">Suppliers and their approval status</caption>
          <thead>
            <tr>
              <th scope="col">Supplier</th>
              <th scope="col">XRPL address</th>
              <th scope="col">Approval</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td data-label="Supplier" className="supplier-name">
                  {s.name}
                </td>
                <td data-label="XRPL address">
                  <span className="address" title={s.xrpl_address}>
                    {shortAddress(s.xrpl_address)}
                  </span>{" "}
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => copy(s)} aria-label={`Copy full XRPL address for ${s.name}`}>
                    Copy
                  </button>
                </td>
                <td data-label="Approval">{s.is_approved ? <StatusBadge tone="ok" label="Approved" /> : <StatusBadge tone="warn" label="Not approved" />}</td>
                <td data-label="Status">{s.is_active ? <StatusBadge tone="ok" label="Active" /> : <StatusBadge tone="neutral" label="Inactive" />}</td>
                <td data-label="Actions">
                  <div className="actions">
                    <button
                      type="button"
                      className={s.is_approved ? "btn btn-secondary" : "btn"}
                      disabled={busyId === s.id}
                      onClick={() => patch(s, { is_approved: !s.is_approved }, s.is_approved ? "approval removed." : "approved.")}
                      aria-label={`${s.is_approved ? "Remove approval for" : "Approve"} ${s.name}`}
                    >
                      {s.is_approved ? "Remove approval" : "Approve"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busyId === s.id}
                      onClick={() => patch(s, { is_active: !s.is_active }, s.is_active ? "deactivated." : "activated.")}
                      aria-label={`${s.is_active ? "Deactivate" : "Activate"} ${s.name}`}
                    >
                      {s.is_active ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <p role="status" aria-live="polite" className="status">
        {status}
      </p>
    </>
  );
}
