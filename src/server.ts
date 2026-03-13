import express, { Request, Response } from 'express'

// import { evaluate } from '@timlavelle/sdk-core-policy'
// TODO: wire to sdk-core-policy when logic is implemented

const app = express()
app.use(express.json())

const SERVICE = 'iq-policy-decision-service'
const VERSION = '0.1.0'

// POST /v1/decisions/policy
// Evaluates policy entitlement for a given customer + scenario
app.post('/v1/decisions/policy', async (req: Request, res: Response) => {
  const { customerId, tier, scenarioType, bookingClass } = req.body

  // Platinum One waiver logic — sdk-core-policy will own this rule
  const isPlatinumOne = tier === 'Platinum One'
  const isDisruption = scenarioType === 'disruption'
  const isVoluntaryChange = scenarioType === 'voluntary_change'

  if (isDisruption) {
    return res.json({
      eligible: true,
      changeFee: 0,
      waivingReason: 'Disruption waiver — airline-initiated cancellation',
      policyRef: 'POL-DIS-0011',
      source: `sdk-core-policy · ${SERVICE} v${VERSION}`,
      aiConfidence: 0.99,
    })
  }

  if (isVoluntaryChange && isPlatinumOne) {
    return res.json({
      eligible: true,
      changeFee: 0,
      waivingReason: 'Platinum One — fee waived within 7 days of travel',
      policyRef: 'POL-FC-0042',
      source: `sdk-core-policy · ${SERVICE} v${VERSION}`,
      aiConfidence: 0.97,
    })
  }

  if (isVoluntaryChange) {
    return res.json({
      eligible: true,
      changeFee: 250,
      currency: 'AUD',
      waivingReason: null,
      policyRef: 'POL-FC-0042',
      source: `sdk-core-policy · ${SERVICE} v${VERSION}`,
      aiConfidence: 0.97,
    })
  }

  // Default — baggage / general entitlement
  return res.json({
    eligible: true,
    autoApprovalThreshold: 250,
    currency: 'AUD',
    policyRef: 'POL-BAG-0023',
    source: `sdk-core-policy · ${SERVICE} v${VERSION}`,
    aiConfidence: 0.95,
  })
})

// POST /v1/decisions/entitlement
// SVoP — Single View of Policy lookup by policy ID or keyword
app.post('/v1/decisions/entitlement', async (req: Request, res: Response) => {
  const { policyRef, query } = req.body

  return res.json({
    policyRef: policyRef ?? 'POL-BAG-0023',
    title: 'Delayed / Damaged Baggage Compensation',
    autoApprovalLimit: 250,
    currency: 'AUD',
    requiresReceipt: false,
    escalationThreshold: 1000,
    ragContext: query
      ? `Policy retrieved via SVoP RAG pipeline for query: "${query}"`
      : null,
    source: `sdk-core-policy · ${SERVICE} v${VERSION}`,
  })
})

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: SERVICE, version: VERSION })
})

const PORT = process.env.PORT ?? 3001
app.listen(PORT, () => console.log(`${SERVICE} :${PORT}`))
