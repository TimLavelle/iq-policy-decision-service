# GoRules DMN Decision Tables
## Policy Decision Service — Rule Files

These JSON files define the business rules evaluated by the GoRules ZEN Engine inside `iq-policy-decision-service`. They replace hardcoded `if/else` logic with structured, auditable, business-editable decision tables.

---

## What is DMN?

**DMN** (Decision Model and Notation) is an OMG standard for representing business decisions as tables.
**GoRules JDM** (JSON Decision Model) is GoRules' JSON implementation — the same semantics, stored as `.json` files, editable via [GoRules Studio](https://editor.gorules.io).

Each file is a decision graph: Input → Decision Table → Output.

---

## Files in this directory

| File | Purpose | Inputs | Key output |
|---|---|---|---|
| `flight-change-fee.json` | Voluntary flight change fee rules | customerTier, daysBeforeDeparture, fareClass | changeFeeDue (AUD) |
| `baggage-claim-threshold.json` | Baggage claim auto-approval limits | customerTier, claimAmountAUD | autoApprove, approvalLimit |
| `disruption-policy.json` | Flight disruption entitlements | disruptionType, customerTier | mealVoucher, loungeAccess, hotelEligible |

---

## How to read a decision table

Each rule is a row. Columns are inputs (conditions) and outputs (results).
Rules are evaluated **top to bottom** with a **first-match** hit policy — the first row where all conditions are satisfied produces the result.

An **empty input cell** means "match any value" for that column.

### Example: flight-change-fee.json

| customerTier | daysBeforeDeparture | fareClass | changeFeeDue | waivingReason |
|---|---|---|---|---|
| "Platinum One" | (any) | (any) | **0** | "Platinum One — fee waived" |
| (any) | ≤ 1 | (any) | **0** | "Within 24 hours — fee waived" |
| "Platinum" | ≤ 7 | "Business" | **0** | "Platinum Business within 7 days" |
| "Platinum" | > 7 | "Business" | **150** | — |
| (default) | (any) | (any) | **250** | — |

---

## How rule changes propagate

```
Business user edits a rule in GoRules Studio UI
        ↓
Change committed to this repo (src/rules/*.json)
        ↓
GitHub Actions CI pipeline triggers
        ↓
iq-policy-decision-service redeploys on Railway
        ↓
New rules are live — zero code changes required
```

In production, the Revenue and Policy teams can edit rule thresholds (fees, approval limits, entitlement conditions) directly via the GoRules Studio no-code editor. Developers only need to be involved when the *structure* of a rule table changes (adding/removing columns).

---

## Calling the rules engine (for developers)

```typescript
import { ZenEngine } from '@gorules/zen-engine';
import fs from 'fs/promises';
import path from 'path';

const RULES_DIR = path.join(__dirname, 'rules');

const engine = new ZenEngine({
  loader: async (key: string) => fs.readFile(path.join(RULES_DIR, key)),
});

// Flight change fee evaluation
const result = await engine.evaluate('flight-change-fee.json', {
  customerTier: 'Platinum One',
  daysBeforeDeparture: 3,
  fareClass: 'Business',
});
// result.result → { changeFeeDue: 0, waivingReason: "Platinum One — fee waived", policyRef: "POL-FC-0042" }
```

---

## GoRules references

- Free online editor: [editor.gorules.io](https://editor.gorules.io)
- Documentation: [gorules.io/docs](https://gorules.io/docs)
- npm package: `@gorules/zen-engine`
- Used in: `iq-policy-decision-service` · `iq-e2ejm-journey-orchestrator`
- Architecture layer: **Journey Orchestration** (Layer 3) — Workflow & Decision Engine
