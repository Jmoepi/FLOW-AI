# Task 1 changes (Flow_AI_MVP_README_v3.5.md)

a. Section 16: reordered so Step 2 is M1 (XRPL adapter, first validated transfer) and Step 3 is M2 (domain and policy engine). Replaced the "run Step 3 before Step 2" note with a statement that M1 precedes M2. Steps 1 and 4-9 keep their numbers. Step 2's reference to "Step 1" is unchanged and still correct.
b. Section 15 milestone table: Rough time filled for M0-M8 (1, 2, 2, 3, 2, 4, 4, 1.5, 3 hours). Added a sentence marking them as estimates: about 18 h to the cut line (M0-M6), about 22.5 h with M7 and M8. Cut line and regular-key P1 wording untouched.
c. Section 14A: weights label now says supplied by the product owner from the hackathon judging brief; confirm against the Participant Hub. Numbers unchanged; no verification claimed.

## Checks run
- `grep -nE "Step [0-9]"` on the README: only section 16 headings and the "Step 1" reference in Step 2 remain; no other doc text refers to step numbers.
- `grep -n "Participant Hub"`: all references consistent.
- Section X.Y references were not renumbered (no headings changed), so none broke.

## Review fix

Restored Flow_AI_MVP_README_v3.0.md from .agents/tasks/v3.0-backup.md; sha256 952fa91d...be6d verified identical. v3.0 content was not edited.
