# Real agent payment, XRPL Testnet (recorded, secret-free)

RECORDED RUN (not live). 2026-11-14. Command: `pnpm agent:demo -- --enable-execution --regular-key`, then `pnpm agent:demo -- --verify-paid`. Deterministic mode, no LLM. Local native Postgres. The guard signed with the treasury's regular key. JSON log lines and database ids are omitted; no seed, token or connection string appears here.

```
Before: treasury 17 RLUSD, supplier 2 RLUSD
Guard ready (Testnet, local database, execution ENABLED).
status=blocked mode=deterministic tool_calls=4 decision=PAYMENT_LIMIT_EXCEEDED summary="Payment not submitted. The amount 5 exceeds the per-payment cap of 2. No funds were moved."
transcript=docs/demo/agent-run-20261114T054705Z-blocked.json
Blocked run complete: no hash, treasury unchanged.
Waiting 65 s so the guard rate-limit window (30 requests per minute) is clear for the paid run...
Starting the ONE authorised real agent run...
status=paid mode=deterministic tool_calls=5 decision=ALLOWED payment=7aaa2d75-e41d-49e1-bec9-54601300ba69
tx=237170E2F24845D2FB5FD920913971DFA53C567536C165501FA66C473EED352D
explorer=https://testnet.xrpl.org/transactions/237170E2F24845D2FB5FD920913971DFA53C567536C165501FA66C473EED352D
summary="Paid 1 RLUSD. The transaction was validated on the XRPL Testnet ledger."
transcript=docs/demo/agent-run-20261114T054829Z-paid.json
```

The in-script replay check failed an assertion because it omitted the stored `agent_reason`, so the guard correctly answered 409 (same key, different request). That check was fixed and run afterwards against the kept database with the kill switch OFF:

```
Verification guard ready (execution DISABLED).
Proof: replay_http=200 replay_status=validated duplicate_http=200 duplicate_status=blocked duplicate_code=undefined
Proof: run_status=paid audit_chain_valid=true validated_payments=1 payment_rows=2 treasury_after=16
```

Ledger check (`tx` on https://s.altnet.rippletest.net:51234/): validated, ledger 22311601, `tesSUCCESS`, `delivered_amount` 1 RLUSD, `SigningPubKey` equal to the public key of the regular key `rBo9yA5iS9y8D1GNmz7eLnZqfYEHei5fpb`. Treasury 17 -> 16 RLUSD, supplier 2 -> 3 RLUSD.
