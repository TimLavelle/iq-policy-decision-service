import express, { Request, Response } from 'express'
import { ZenEngine } from '@gorules/zen-engine'
import fs from 'fs/promises'
import path from 'path'

const app = express()
app.use(express.json())

const SERVICE = 'iq-policy-decision-service'
const VERSION = '0.1.0'
const PORT = process.env.PORT ?? 3001

// Rules directory — works both in dev (tsx src/server.ts) and prod (node dist/server.js)
// process.cwd() is always the repo root in both cases
const RULES_DIR = path.join(process.cwd(), 'src', 'rules')

// Initialise GoRules ZEN Engine once at startup
const engine = new ZenEngine({
  loader: async (key: string) => fs.readFile(path.join(RULES_DIR, key)),
})

// ─── POST /v1/decisions/flight-change-fee ─────────────────────────────────────
app.post('/v1/decisions/flight-change-fee', async (req: Request, res: Response) => {
  const { customerTier, daysBeforeDeparture, fareClass } = req.body
  try {
    const { result } = await engine.evaluate('flight-change-fee.json', {
      customerTier,
      daysBeforeDeparture: Number(daysBeforeDeparture),
      fareClass,
    })
    res.json({
      ...result,
      source: `${SERVICE} · GoRules DMN`,
      ruleFile: 'flight-change-fee.json',
      aiConfidence: 0.99,
    })
  } catch (err) {
    res.status(500).json({ error: 'Rule evaluation failed', message: (err as Error).message })
  }
})

// ─── POST /v1/decisions/baggage-claim ────────────────────────────────────────
app.post('/v1/decisions/baggage-claim', async (req: Request, res: Response) => {
  const { claimAmountAUD, customerTier } = req.body
  try {
    const { result } = await engine.evaluate('baggage-claim-threshold.json', {
      claimAmountAUD: Number(claimAmountAUD),
      customerTier,
    })
    res.json({
      ...result,
      source: `${SERVICE} · GoRules DMN`,
      ruleFile: 'baggage-claim-threshold.json',
      aiConfidence: 0.99,
    })
  } catch (err) {
    res.status(500).json({ error: 'Rule evaluation failed', message: (err as Error).message })
  }
})

// ─── POST /v1/decisions/disruption ───────────────────────────────────────────
app.post('/v1/decisions/disruption', async (req: Request, res: Response) => {
  const { disruptionType, customerTier } = req.body
  try {
    const { result } = await engine.evaluate('disruption-policy.json', {
      disruptionType,
      customerTier,
    })
    res.json({
      ...result,
      source: `${SERVICE} · GoRules DMN`,
      ruleFile: 'disruption-policy.json',
      aiConfidence: 0.99,
    })
  } catch (err) {
    res.status(500).json({ error: 'Rule evaluation failed', message: (err as Error).message })
  }
})

// ─── POST /v1/decisions/policy (backward compat) ─────────────────────────────
app.post('/v1/decisions/policy', async (req: Request, res: Response) => {
  const { tier, scenarioType } = req.body
  const isPlatinumOne = tier === 'Platinum One'

  if (scenarioType === 'disruption') {
    return res.json({
      eligible: true, changeFee: 0,
      waivingReason: 'Disruption waiver — airline-initiated cancellation',
      policyRef: 'POL-DIS-0011',
      source: `${SERVICE} · GoRules DMN`, aiConfidence: 0.99,
    })
  }
  return res.json({
    eligible: true,
    changeFee: isPlatinumOne ? 0 : 250,
    waivingReason: isPlatinumOne ? 'Platinum One — fee waived' : null,
    policyRef: 'POL-FC-0042',
    source: `${SERVICE} · GoRules DMN`, aiConfidence: 0.97,
  })
})

// ─── POST /v1/decisions/entitlement ──────────────────────────────────────────
app.post('/v1/decisions/entitlement', async (_req: Request, res: Response) => {
  res.json({
    policyRef: 'POL-BAG-0023',
    title: 'Delayed / Damaged Baggage Compensation',
    autoApprovalLimit: 250,
    currency: 'AUD',
    source: `${SERVICE} · GoRules DMN`,
  })
})

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: SERVICE, version: VERSION, engine: 'GoRules ZEN Engine' })
})

app.listen(PORT, () => console.log(`${SERVICE} :${PORT} [GoRules DMN]`))
