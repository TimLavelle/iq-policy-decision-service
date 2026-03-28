// rule-store.ts — Redis-backed rule persistence with filesystem fallback.
// Rules are stored in Redis as JSON strings under "rules:{name}".
// On startup the policy service seeds Redis from disk if keys are absent.
// Saves are instant — no redeploy required. The "Deploy" button in the
// Policy Studio promotes the current Redis state to Railway by triggering
// a redeployment (the new instance seeds from Redis, not disk).

import fs from 'fs/promises'
import path from 'path'
import { getRedis } from './redis.js'

const RULES_DIR = path.join(process.cwd(), 'src', 'rules')

const KNOWN_RULES = [
  'flight-change-fee.json',
  'baggage-claim-threshold.json',
  'disruption-policy.json',
] as const

export type RuleName = typeof KNOWN_RULES[number]

const RULE_META: Record<string, { displayName: string; description: string; inputs: string[]; outputs: string[]; decisionEndpoint: string }> = {
  'flight-change-fee.json': {
    displayName: 'Flight Change Fee',
    description: 'Determines the change fee due for voluntary flight changes based on customer tier, fare class, and days before departure.',
    inputs: ['customerTier', 'daysBeforeDeparture', 'fareClass'],
    outputs: ['changeFeeDue', 'waivingReason', 'policyRef'],
    decisionEndpoint: '/v1/decisions/flight-change-fee',
  },
  'baggage-claim-threshold.json': {
    displayName: 'Baggage Claim Threshold',
    description: 'Sets auto-approval limits for baggage damage and delay claims based on customer tier and claim amount.',
    inputs: ['customerTier', 'claimAmountAUD'],
    outputs: ['autoApprove', 'approvalLimit', 'policyRef'],
    decisionEndpoint: '/v1/decisions/baggage-claim',
  },
  'disruption-policy.json': {
    displayName: 'Disruption Entitlements',
    description: 'Defines customer entitlements (meal vouchers, lounge access, hotel) for flight disruptions by type and tier.',
    inputs: ['disruptionType', 'customerTier'],
    outputs: ['mealVoucher', 'loungeAccess', 'hotelEligible', 'policyRef'],
    decisionEndpoint: '/v1/decisions/disruption',
  },
}

export function ruleKey(name: string): string {
  return `rules:${name}`
}

export function listRules(): typeof KNOWN_RULES[number][] {
  return [...KNOWN_RULES]
}

export function getRuleMeta() {
  return KNOWN_RULES.map(name => ({
    name,
    ...RULE_META[name],
  }))
}

/** Load a rule — Redis first, filesystem fallback */
export async function loadRule(name: string): Promise<Buffer> {
  const redis = getRedis()
  if (redis) {
    try {
      const cached = await redis.get<string>(ruleKey(name))
      if (cached) return Buffer.from(cached, 'utf-8')
    } catch {
      // Redis unavailable — fall through to filesystem
    }
  }
  return fs.readFile(path.join(RULES_DIR, name))
}

/** Save a rule to Redis and sync to disk as a best-effort backup */
export async function saveRule(name: string, content: string): Promise<void> {
  const redis = getRedis()
  if (!redis) throw new Error('Redis not configured — cannot persist rule changes')
  await redis.set(ruleKey(name), content)
  // Best-effort disk sync (non-fatal — Railway filesystem is ephemeral)
  fs.writeFile(path.join(RULES_DIR, name), content, 'utf-8').catch(() => {})
}

/** On startup: seed Redis with filesystem rules for any key not yet present */
export async function seedRulesIntoRedis(): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  await Promise.all(
    KNOWN_RULES.map(async name => {
      try {
        const existing = await redis.get<string>(ruleKey(name))
        if (!existing) {
          const content = await fs.readFile(path.join(RULES_DIR, name), 'utf-8')
          await redis.set(ruleKey(name), content)
          console.log(`[rule-store] seeded ${name} into Redis`)
        }
      } catch (err) {
        console.warn(`[rule-store] failed to seed ${name}:`, (err as Error).message)
      }
    })
  )
}
