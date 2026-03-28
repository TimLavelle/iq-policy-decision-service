// decision-logger.ts — Ring-buffer decision logging for anomaly detection.
// Every rule evaluation is logged to Redis LIST "decisions:log" (newest-first).
// Capped at 500 entries via LTRIM. Reads by the anomaly detector and audit trail.

import { getRedis } from './redis'

export const DECISIONS_LOG_KEY = 'decisions:log'
const MAX_LOG_SIZE = 500

export interface DecisionLogEntry {
  id: string
  timestamp: string       // ISO-8601
  ruleFile: string
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
  durationMs: number
}

export async function logDecision(entry: DecisionLogEntry): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.lpush(DECISIONS_LOG_KEY, JSON.stringify(entry))
    await redis.ltrim(DECISIONS_LOG_KEY, 0, MAX_LOG_SIZE - 1)
  } catch {
    // Non-fatal — logging must never block a decision response
  }
}

export async function getDecisionLog(limit = 100, ruleFile?: string): Promise<DecisionLogEntry[]> {
  const redis = getRedis()
  if (!redis) return []
  try {
    const raw = await redis.lrange<string>(DECISIONS_LOG_KEY, 0, MAX_LOG_SIZE - 1)
    const entries = raw
      .map(r => {
        try { return JSON.parse(r) as DecisionLogEntry } catch { return null }
      })
      .filter((e): e is DecisionLogEntry => e !== null)
      .filter(e => !ruleFile || e.ruleFile === ruleFile)
    return entries.slice(0, limit)
  } catch {
    return []
  }
}

export interface AnomalySignal {
  id: string
  ruleFile: string
  severity: 'low' | 'medium' | 'high'
  description: string
  affectedCount: number
  detectedAt: string
  sampleEntries: DecisionLogEntry[]
}

/** Simple statistical anomaly detection over the recent decision log */
export async function detectAnomalies(ruleFile?: string): Promise<{ anomalies: AnomalySignal[]; analysedCount: number }> {
  const entries = await getDecisionLog(500, ruleFile)
  const anomalies: AnomalySignal[] = []

  if (!entries.length) return { anomalies: [], analysedCount: 0 }

  // Group by ruleFile
  const byRule = new Map<string, DecisionLogEntry[]>()
  for (const e of entries) {
    const list = byRule.get(e.ruleFile) ?? []
    list.push(e)
    byRule.set(e.ruleFile, list)
  }

  for (const [rule, ruleEntries] of byRule) {
    const n = ruleEntries.length

    // ── Slow evaluations (>500ms) ──────────────────────────────────────────────
    const slow = ruleEntries.filter(e => e.durationMs > 500)
    if (slow.length > 0) {
      anomalies.push({
        id: `perf-${rule}`,
        ruleFile: rule,
        severity: slow.length > 5 ? 'high' : 'medium',
        description: `${slow.length} decision${slow.length > 1 ? 's' : ''} took >500ms (avg ${Math.round(slow.reduce((s, e) => s + e.durationMs, 0) / slow.length)}ms). May indicate Redis latency or ZEN engine issue.`,
        affectedCount: slow.length,
        detectedAt: new Date().toISOString(),
        sampleEntries: slow.slice(0, 3),
      })
    }

    // ── Outcome concentration (>60% identical output key) ────────────────────
    if (rule === 'baggage-claim-threshold.json') {
      const autoApproved = ruleEntries.filter(e => e.outputs.autoApprove === true).length
      const ratio = autoApproved / n
      if (ratio > 0.8 && n >= 10) {
        anomalies.push({
          id: `concentration-approve-${rule}`,
          ruleFile: rule,
          severity: 'medium',
          description: `${Math.round(ratio * 100)}% of baggage claims are auto-approved (${autoApproved}/${n}). Consider whether approval thresholds are calibrated correctly.`,
          affectedCount: autoApproved,
          detectedAt: new Date().toISOString(),
          sampleEntries: ruleEntries.filter(e => e.outputs.autoApprove === true).slice(0, 3),
        })
      }
    }

    if (rule === 'flight-change-fee.json') {
      const feeWaived = ruleEntries.filter(e => Number(e.outputs.changeFeeDue) === 0).length
      const ratio = feeWaived / n
      if (ratio > 0.7 && n >= 10) {
        anomalies.push({
          id: `concentration-waived-${rule}`,
          ruleFile: rule,
          severity: 'low',
          description: `${Math.round(ratio * 100)}% of flight change fees are waived (${feeWaived}/${n}). Revenue impact may be higher than expected if customer tier mix has shifted.`,
          affectedCount: feeWaived,
          detectedAt: new Date().toISOString(),
          sampleEntries: ruleEntries.filter(e => Number(e.outputs.changeFeeDue) === 0).slice(0, 3),
        })
      }
    }

    // ── Unusual tier/outcome combinations ─────────────────────────────────────
    if (rule === 'flight-change-fee.json') {
      const platOneWithFee = ruleEntries.filter(
        e => e.inputs.customerTier === 'Platinum One' && Number(e.outputs.changeFeeDue) > 0
      )
      if (platOneWithFee.length > 0) {
        anomalies.push({
          id: `anomaly-plat-one-fee-${rule}`,
          ruleFile: rule,
          severity: 'high',
          description: `${platOneWithFee.length} Platinum One customer${platOneWithFee.length > 1 ? 's' : ''} were charged a change fee. This contradicts the Platinum One fee-waiver rule — investigate immediately.`,
          affectedCount: platOneWithFee.length,
          detectedAt: new Date().toISOString(),
          sampleEntries: platOneWithFee.slice(0, 3),
        })
      }
    }
  }

  return { anomalies, analysedCount: entries.length }
}
