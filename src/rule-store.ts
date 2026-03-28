// rule-store.ts — Redis-backed rule persistence with filesystem fallback.
// Rules are stored in Redis as JSON strings under "rules:{name}".
// On startup the policy service seeds Redis from disk if keys are absent.
// Saves are instant — no redeploy required. The "Deploy" button in the
// Policy Studio promotes the current Redis state to Railway by triggering
// a redeployment (the new instance seeds from Redis, not disk).

import fs from 'fs/promises'
import path from 'path'
import { getRedis } from './redis'

const RULES_DIR = path.join(process.cwd(), 'src', 'rules')

const KNOWN_RULES = [
  // Servicing
  'flight-change-fee.json',
  'flight-cancel-refund.json',
  'same-day-standby.json',
  'name-change-eligibility.json',
  // Disruption
  'disruption-policy.json',
  'disruption-rebooking-priority.json',
  'weather-waiver-eligibility.json',
  // Baggage
  'baggage-claim-threshold.json',
  'baggage-allowance.json',
  'excess-baggage-fee.json',
  'special-item-fee.json',
  // Loyalty
  'points-earn-rate.json',
  'status-credit-earn.json',
  'upgrade-eligibility.json',
  'lounge-access-eligibility.json',
  // Risk & Compliance
  'fraud-risk-threshold.json',
  'refund-velocity-check.json',
  'refund-method-eligibility.json',
] as const

export type RuleName = typeof KNOWN_RULES[number]

const RULE_META: Record<string, { displayName: string; description: string; inputs: string[]; outputs: string[]; decisionEndpoint: string; group: string }> = {
  // ── Servicing ─────────────────────────────────────────────────────────────
  'flight-change-fee.json': {
    group: 'Servicing',
    displayName: 'Flight Change Fee',
    description: 'Determines the change fee due for voluntary flight changes based on customer tier, fare class, and days before departure.',
    inputs: ['customerTier', 'daysBeforeDeparture', 'fareClass'],
    outputs: ['changeFeeDue', 'waivingReason', 'policyRef'],
    decisionEndpoint: '/v1/decisions/flight-change-fee',
  },
  'flight-cancel-refund.json': {
    group: 'Servicing',
    displayName: 'Flight Cancellation Refund',
    description: 'Determines refund eligibility, method (cash/travel bank/non-refundable), and processing time for cancelled bookings by fare class and tier.',
    inputs: ['fareClass', 'customerTier', 'daysBeforeDeparture'],
    outputs: ['refundEligible', 'refundType', 'refundPercentage', 'processingDays', 'policyRef'],
    decisionEndpoint: '/v1/decisions/flight-cancel-refund',
  },
  'same-day-standby.json': {
    group: 'Servicing',
    displayName: 'Same Day Standby',
    description: 'Controls eligibility for same-day standby waitlisting, queue priority, and associated fees by tier, fare class, and route type.',
    inputs: ['customerTier', 'fareClass', 'routeType'],
    outputs: ['eligible', 'priority', 'fee', 'policyRef'],
    decisionEndpoint: '/v1/decisions/same-day-standby',
  },
  'name-change-eligibility.json': {
    group: 'Servicing',
    displayName: 'Name Change Eligibility',
    description: 'Governs permitted PNR name corrections and transfers, including fees, documentation requirements, and timing restrictions.',
    inputs: ['changeType', 'daysBeforeDeparture', 'customerTier'],
    outputs: ['permitted', 'fee', 'requiresDocumentation', 'processingHours', 'policyRef'],
    decisionEndpoint: '/v1/decisions/name-change',
  },
  // ── Disruption ────────────────────────────────────────────────────────────
  'disruption-policy.json': {
    group: 'Disruption',
    displayName: 'Disruption Entitlements',
    description: 'Defines customer entitlements (meal vouchers, lounge access, hotel) for flight disruptions by disruption type and tier.',
    inputs: ['disruptionType', 'customerTier'],
    outputs: ['mealVoucher', 'loungeAccess', 'hotelEligible', 'policyRef'],
    decisionEndpoint: '/v1/decisions/disruption',
  },
  'disruption-rebooking-priority.json': {
    group: 'Disruption',
    displayName: 'Rebooking Priority',
    description: 'Assigns queue priority level and fast-track eligibility during disruption rebooking, weighted by tier and whether a connecting flight is affected.',
    inputs: ['customerTier', 'disruptionType', 'hasConnectingFlight'],
    outputs: ['priorityLevel', 'fastTrackEligible', 'dedicatedAgentQueue', 'maxRebookingWindow', 'policyRef'],
    decisionEndpoint: '/v1/decisions/disruption-rebooking-priority',
  },
  'weather-waiver-eligibility.json': {
    group: 'Disruption',
    displayName: 'Weather & Waiver Eligibility',
    description: 'Determines whether a weather or operational waiver applies, waiving change fees and extending the eligible rebooking window by event type and fare class.',
    inputs: ['waiverType', 'fareClass', 'customerTier'],
    outputs: ['waiverApproved', 'changeFeeWaived', 'changePeriodDays', 'refundEligible', 'policyRef'],
    decisionEndpoint: '/v1/decisions/weather-waiver',
  },
  // ── Baggage ───────────────────────────────────────────────────────────────
  'baggage-claim-threshold.json': {
    group: 'Baggage',
    displayName: 'Baggage Claim Threshold',
    description: 'Sets auto-approval limits for baggage damage and delay claims based on customer tier and claim amount.',
    inputs: ['customerTier', 'claimAmountAUD'],
    outputs: ['autoApprove', 'approvalLimit', 'requiresReview', 'policyRef'],
    decisionEndpoint: '/v1/decisions/baggage-claim',
  },
  'baggage-allowance.json': {
    group: 'Baggage',
    displayName: 'Baggage Allowance',
    description: 'Calculates the number of included checked bags and weight limits based on fare class, customer tier, and route type.',
    inputs: ['fareClass', 'customerTier', 'routeType'],
    outputs: ['checkedBagsIncluded', 'weightLimitKgPerBag', 'carryOnKg', 'policyRef'],
    decisionEndpoint: '/v1/decisions/baggage-allowance',
  },
  'excess-baggage-fee.json': {
    group: 'Baggage',
    displayName: 'Excess Baggage Fee',
    description: 'Calculates per-kg excess baggage fees and first-excess-bag charges by route type, with tier-based discounts for Platinum and above.',
    inputs: ['routeType', 'customerTier'],
    outputs: ['feePerKgAUD', 'firstExcessBagFeeAUD', 'maxWeightKg', 'policyRef'],
    decisionEndpoint: '/v1/decisions/excess-baggage',
  },
  'special-item-fee.json': {
    group: 'Baggage',
    displayName: 'Special Item Fee',
    description: 'Determines fees, dimension limits, and advance booking requirements for sports equipment, musical instruments, and oversized items.',
    inputs: ['itemType', 'routeType'],
    outputs: ['feeAUD', 'maxDimensionCm', 'advanceBookingRequired', 'maxWeightKg', 'policyRef'],
    decisionEndpoint: '/v1/decisions/special-item',
  },
  // ── Loyalty ───────────────────────────────────────────────────────────────
  'points-earn-rate.json': {
    group: 'Loyalty',
    displayName: 'Points Earn Rate',
    description: 'Calculates Qantas Points earned per dollar spent and status credit per segment by fare class and customer tier, including tier bonus multipliers.',
    inputs: ['fareClass', 'customerTier', 'partnerCode'],
    outputs: ['pointsPerDollar', 'bonusMultiplier', 'statusCreditsPerSegment', 'policyRef'],
    decisionEndpoint: '/v1/decisions/points-earn',
  },
  'status-credit-earn.json': {
    group: 'Loyalty',
    displayName: 'Status Credit Earn',
    description: 'Determines the number of status credits awarded per flight segment based on fare class, route distance, and operating carrier.',
    inputs: ['fareClass', 'routeDistance', 'carrierCode'],
    outputs: ['statusCredits', 'bonusCredits', 'eligibleForDouble', 'policyRef'],
    decisionEndpoint: '/v1/decisions/status-credits',
  },
  'upgrade-eligibility.json': {
    group: 'Loyalty',
    displayName: 'Upgrade Eligibility',
    description: 'Governs complimentary, points-based, and paid upgrade eligibility by tier, fare class, route type, and days before departure.',
    inputs: ['customerTier', 'fareClass', 'routeType', 'daysBeforeDeparture'],
    outputs: ['upgradeEligible', 'upgradeType', 'priorityLevel', 'policyRef'],
    decisionEndpoint: '/v1/decisions/upgrade',
  },
  'lounge-access-eligibility.json': {
    group: 'Loyalty',
    displayName: 'Lounge Access Eligibility',
    description: 'Determines which Qantas lounge tier a customer can access, guest allowance count, and day-use eligibility based on fare class and tier.',
    inputs: ['customerTier', 'fareClass', 'routeType'],
    outputs: ['loungeAccess', 'guestAllowance', 'dayUseEligible', 'loungeType', 'policyRef'],
    decisionEndpoint: '/v1/decisions/lounge-access',
  },
  // ── Risk & Compliance ─────────────────────────────────────────────────────
  'fraud-risk-threshold.json': {
    group: 'Risk & Compliance',
    displayName: 'Fraud Risk Threshold',
    description: 'Evaluates transaction risk score and amount to determine auto-approval, MFA requirement, or decline action for payment transactions.',
    inputs: ['transactionAmountAUD', 'riskScore', 'accountAgeDays'],
    outputs: ['action', 'requiresMFA', 'maxAutoApprovalAUD', 'notifyFraudTeam', 'policyRef'],
    decisionEndpoint: '/v1/decisions/fraud-risk',
  },
  'refund-velocity-check.json': {
    group: 'Risk & Compliance',
    displayName: 'Refund Velocity Check',
    description: 'Flags unusual refund patterns by checking refund frequency and total amount in a rolling 30-day window, with tier-adjusted thresholds.',
    inputs: ['refundsInLast30Days', 'totalRefundAmountAUD', 'customerTier'],
    outputs: ['allowed', 'requiresManualReview', 'flagForFraud', 'holdDays', 'policyRef'],
    decisionEndpoint: '/v1/decisions/refund-velocity',
  },
  'refund-method-eligibility.json': {
    group: 'Risk & Compliance',
    displayName: 'Refund Method Eligibility',
    description: 'Determines the permitted refund method (original payment, Travel Bank, points) based on original payment type, fare class, and refund amount.',
    inputs: ['originalPaymentMethod', 'fareClass', 'refundAmountAUD'],
    outputs: ['refundMethod', 'processingDays', 'feeAUD', 'requiresVerification', 'policyRef'],
    decisionEndpoint: '/v1/decisions/refund-method',
  },
}

export function ruleKey(name: string): string {
  return `rules:${name}`
}

export function descKey(name: string): string {
  return `rules:${name}:desc`
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

/** Read description — Redis first (editable), fallback to hardcoded RULE_META */
export async function getRuleDescription(name: string): Promise<string> {
  const redis = getRedis()
  if (redis) {
    try {
      const stored = await redis.get<string>(descKey(name))
      if (stored) return stored
    } catch { /* fall through */ }
  }
  return RULE_META[name]?.description ?? ''
}

/** Persist an edited description to Redis */
export async function setRuleDescription(name: string, description: string): Promise<void> {
  const redis = getRedis()
  if (!redis) throw new Error('Redis not configured — cannot persist description')
  await redis.set(descKey(name), description)
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
