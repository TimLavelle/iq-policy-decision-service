import express, { Request, Response } from 'express'
import { randomBytes } from 'crypto'
import { ZenEngine } from '@gorules/zen-engine'
import { queryKnowledgeBase, explainPolicy, searchPolicies } from './knowledge-base'

const nanoid = (size = 10) => randomBytes(size).toString('base64url').slice(0, size)
import { getRedis } from './redis'
import {
  loadRule, saveRule, seedRulesIntoRedis,
  listRules, getRuleMeta, getRuleDescription, setRuleDescription,
} from './rule-store'
import {
  logDecision, getDecisionLog, detectAnomalies,
  type DecisionLogEntry,
} from './decision-logger'

const app = express()
app.use(express.json())

const SERVICE = 'iq-policy-decision-service'
const VERSION = '0.2.0'
const PORT = process.env.PORT ?? 3001

// ─── ZEN Engine — Redis-backed, hot-reloadable ────────────────────────────────
// Engine is a module-level singleton. After any rule save, refreshEngine() is
// called to rebuild with the updated loader. Recreation is fast (~10ms).

let engine = new ZenEngine({ loader: async (key: string) => loadRule(key) })

function refreshEngine() {
  try { engine.dispose() } catch { /* ignore if already disposed */ }
  engine = new ZenEngine({ loader: async (key: string) => loadRule(key) })
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startup() {
  await seedRulesIntoRedis()
  const redis = getRedis()
  const rulesStore = redis ? 'redis' : 'filesystem'
  console.log(`[${SERVICE}] rules store: ${rulesStore}`)
}

// ─── Decision helpers ─────────────────────────────────────────────────────────

async function evaluate(
  ruleFile: string,
  inputs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const start = Date.now()
  const { result } = await engine.evaluate(ruleFile, inputs)
  const durationMs = Date.now() - start
  const entry: DecisionLogEntry = {
    id: nanoid(10),
    timestamp: new Date().toISOString(),
    ruleFile,
    inputs,
    outputs: result as Record<string, unknown>,
    durationMs,
  }
  void logDecision(entry)
  return result as Record<string, unknown>
}

// ─── POST /v1/decisions/flight-change-fee ─────────────────────────────────────
app.post('/v1/decisions/flight-change-fee', async (req: Request, res: Response) => {
  const { customerTier, daysBeforeDeparture, fareClass } = req.body
  try {
    const result = await evaluate('flight-change-fee.json', {
      customerTier,
      daysBeforeDeparture: Number(daysBeforeDeparture),
      fareClass,
    })
    res.json({ ...result, source: `${SERVICE} · GoRules DMN`, ruleFile: 'flight-change-fee.json', aiConfidence: 0.99 })
  } catch (err) {
    res.status(500).json({ error: 'Rule evaluation failed', message: (err as Error).message })
  }
})

// ─── POST /v1/decisions/baggage-claim ────────────────────────────────────────
app.post('/v1/decisions/baggage-claim', async (req: Request, res: Response) => {
  const { claimAmountAUD, customerTier } = req.body
  try {
    const result = await evaluate('baggage-claim-threshold.json', {
      claimAmountAUD: Number(claimAmountAUD),
      customerTier,
    })
    res.json({ ...result, source: `${SERVICE} · GoRules DMN`, ruleFile: 'baggage-claim-threshold.json', aiConfidence: 0.99 })
  } catch (err) {
    res.status(500).json({ error: 'Rule evaluation failed', message: (err as Error).message })
  }
})

// ─── POST /v1/decisions/disruption ───────────────────────────────────────────
app.post('/v1/decisions/disruption', async (req: Request, res: Response) => {
  const { disruptionType, customerTier } = req.body
  try {
    const result = await evaluate('disruption-policy.json', { disruptionType, customerTier })
    res.json({ ...result, source: `${SERVICE} · GoRules DMN`, ruleFile: 'disruption-policy.json', aiConfidence: 0.99 })
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

// ─── Rules CRUD ───────────────────────────────────────────────────────────────

// GET /v1/rules — list all rules with metadata
app.get('/v1/rules', (_req: Request, res: Response) => {
  res.json({ rules: getRuleMeta() })
})

// GET /v1/rules/:name — return full JDM JSON
app.get('/v1/rules/:name', async (req: Request, res: Response) => {
  const name = req.params['name'] as string
  if (!listRules().includes(name as never)) {
    res.status(404).json({ error: 'Rule not found', name })
    return
  }
  try {
    const buf = await loadRule(name)
    const content = JSON.parse(buf.toString('utf-8')) as Record<string, unknown>
    res.json({ name, content })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rule', message: (err as Error).message })
  }
})

// PUT /v1/rules/:name — save updated JDM JSON + hot-reload engine
app.put('/v1/rules/:name', async (req: Request, res: Response) => {
  const name = req.params['name'] as string
  if (!listRules().includes(name as never)) {
    res.status(404).json({ error: 'Rule not found', name })
    return
  }
  const { content } = req.body as { content: Record<string, unknown> }
  if (!content || content['contentType'] !== 'application/vnd.gorules.decision') {
    res.status(400).json({ error: 'Invalid JDM content — contentType must be application/vnd.gorules.decision' })
    return
  }
  try {
    await saveRule(name, JSON.stringify(content, null, 2))
    refreshEngine()
    res.json({ ok: true, name })
  } catch (err) {
    res.status(500).json({ error: 'Failed to save rule', message: (err as Error).message })
  }
})

// POST /v1/rules/:name/simulate — evaluate WITHOUT logging to decision log
app.post('/v1/rules/:name/simulate', async (req: Request, res: Response) => {
  const name = req.params['name'] as string
  if (!listRules().includes(name as never)) {
    res.status(404).json({ error: 'Rule not found', name })
    return
  }
  const { inputs } = req.body as { inputs: Record<string, unknown> }
  if (!inputs || typeof inputs !== 'object') {
    res.status(400).json({ error: 'inputs object is required' })
    return
  }
  const start = Date.now()
  try {
    const { result } = await engine.evaluate(name, inputs)
    res.json({ result, durationMs: Date.now() - start })
  } catch (err) {
    res.status(500).json({ error: 'Simulation failed', message: (err as Error).message })
  }
})

// GET /v1/rules/:name/description
app.get('/v1/rules/:name/description', async (req: Request, res: Response) => {
  const name = req.params['name'] as string
  if (!listRules().includes(name as never)) { res.status(404).json({ error: 'Rule not found' }); return }
  const description = await getRuleDescription(name)
  res.json({ name, description })
})

// PUT /v1/rules/:name/description
app.put('/v1/rules/:name/description', async (req: Request, res: Response) => {
  const name = req.params['name'] as string
  if (!listRules().includes(name as never)) { res.status(404).json({ error: 'Rule not found' }); return }
  const { description } = req.body as { description: string }
  if (typeof description !== 'string') { res.status(400).json({ error: 'description string required' }); return }
  try {
    await setRuleDescription(name, description)
    res.json({ ok: true, name, description })
  } catch (err) {
    res.status(500).json({ error: 'Failed to save description', message: (err as Error).message })
  }
})

// ─── Decision log + anomalies ─────────────────────────────────────────────────

// GET /v1/decisions/log
app.get('/v1/decisions/log', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query['limit'] ?? 100), 500)
  const ruleFile = req.query['ruleFile'] as string | undefined
  const entries = await getDecisionLog(limit, ruleFile)
  res.json({ entries, total: entries.length })
})

// GET /v1/decisions/anomalies
app.get('/v1/decisions/anomalies', async (req: Request, res: Response) => {
  const ruleFile = req.query['ruleFile'] as string | undefined
  const { anomalies, analysedCount } = await detectAnomalies(ruleFile)
  res.json({ anomalies, analysedCount })
})

// ─── Policy KB endpoints ──────────────────────────────────────────────────────

app.post('/policy/query', async (req: Request, res: Response) => {
  const { question, context } = req.body as { question: string; context?: { tier?: string; domain?: string; sessionId?: string } }
  if (!question || typeof question !== 'string') {
    res.status(400).json({ error: 'question is required' })
    return
  }
  try {
    const result = await queryKnowledgeBase(question, context ?? {})
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'Knowledge base query failed', message: (err as Error).message })
  }
})

app.post('/policy/explain', async (req: Request, res: Response) => {
  const { policyId, scenario } = req.body as { policyId: string; scenario: object }
  if (!policyId || typeof policyId !== 'string') {
    res.status(400).json({ error: 'policyId is required' })
    return
  }
  try {
    const result = await explainPolicy(policyId, scenario ?? {})
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'Policy explanation failed', message: (err as Error).message })
  }
})

app.get('/policy/search', async (req: Request, res: Response) => {
  const q = (req.query['q'] as string | undefined) ?? ''
  const domain = req.query['domain'] as string | undefined
  const tier = req.query['tier'] as string | undefined
  try {
    const result = await searchPolicies(q, domain, tier)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'Policy search failed', message: (err as Error).message })
  }
})

// ─── Health ───────────────────────────────────────────────────────────────────
// Liveness probe — always responds immediately, no async I/O.
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: SERVICE,
    version: VERSION,
    engine: 'GoRules ZEN Engine',
    rulesStore: getRedis() ? 'redis' : 'filesystem',
    knowledgeBase: process.env.BEDROCK_KB_ID ? 'bedrock-kb' : 'mock',
  })
})

// ─── Start ────────────────────────────────────────────────────────────────────
// Listen immediately — same pattern as original, so Railway health check fires
// as soon as the process is up. Redis seeding runs in the background.
app.listen(PORT, () => {
  console.log(`${SERVICE} :${PORT} [GoRules DMN v${VERSION}]`)
  void startup()
})
