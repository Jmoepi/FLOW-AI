# Recorded agent runs

Files here are transcripts written by `pnpm agent:run -- --record` or `pnpm agent:demo`.
Each one is labelled `RECORDED RUN (not live)` and is the demo-video fallback (spec 14.5).

- Secret-free: the writer redacts events and refuses to write if the secret scanner finds anything.
- Names are generated: `agent-run-<UTC>-<status>.json`. The writer only writes inside this directory.
- Fake-ledger transcripts are test-only and never stored here.
- A `paid` recording exists only after the real run (`pnpm agent:demo -- --enable-execution`), which needs the treasury to hold at least 6 RLUSD. One exists (`agent-run-20261114T054829Z-paid.json`, see `real-payment-transcript.md`).

Regenerate: start the guard (`pnpm guard:dev -- --business <uuid>`), then `pnpm agent:run -- --record`.
