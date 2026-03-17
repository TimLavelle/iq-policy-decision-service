#!/usr/bin/env node
/**
 * seed-policies.js
 * Creates 180 structured Qantas policy JSON documents and uploads them to S3,
 * then triggers a Bedrock Knowledge Base ingestion sync job.
 *
 * Usage:
 *   node scripts/seed-policies.js
 *
 * Requires env vars (reads from .env if dotenv is available):
 *   POLICY_DOCUMENTS_BUCKET  — S3 bucket name
 *   BEDROCK_KB_ID            — Bedrock KB ID  (optional, sync skipped if absent)
 *   BEDROCK_KB_DATA_SOURCE_ID — Bedrock DS ID (optional, sync skipped if absent)
 *   AWS_REGION               — defaults to us-east-1
 */

'use strict'

// Load .env from repo root if dotenv is present
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
} catch (_) {
  // dotenv not required — env vars may be injected externally
}

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const { BedrockAgentClient, StartIngestionJobCommand } = require('@aws-sdk/client-bedrock-agent')

const REGION = process.env.AWS_REGION || 'us-east-1'
const BUCKET = process.env.POLICY_DOCUMENTS_BUCKET
const KB_ID = process.env.BEDROCK_KB_ID
const DS_ID = process.env.BEDROCK_KB_DATA_SOURCE_ID

if (!BUCKET) {
  console.error('[ERROR] POLICY_DOCUMENTS_BUCKET is not set. Run scripts/setup-aws-kb.sh first.')
  process.exit(1)
}

const s3 = new S3Client({ region: REGION, followRegionRedirects: true })
const bedrockAgent = new BedrockAgentClient({ region: REGION })

// ─── Policy document factory helpers ─────────────────────────────────────────

const TODAY = '2026-01-01'
const TIERS = ['platinum_one', 'platinum', 'gold', 'silver', 'bronze']
const TIER_LABELS = {
  platinum_one: 'Platinum One',
  platinum: 'Platinum',
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
}

function doc(id, domain, tier, fareClass, title, version, tags, content, structuredData, conditions, relatedPolicies) {
  return {
    id,
    domain,
    tier: tier || 'all',
    fare_class: fareClass || 'all',
    title,
    effective_date: TODAY,
    version,
    tags,
    content,
    structured_data: structuredData || {},
    conditions: conditions || [],
    related_policies: relatedPolicies || [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 1 — DISRUPTION (35 documents)
// ─────────────────────────────────────────────────────────────────────────────

const disruptionDocs = [
  // ── Cancellation by tier (5 docs) ──

  doc('POL-DISR-001', 'disruption', 'all', 'all',
    'Flight Cancellation — Core Rebooking Entitlement (All Tiers)',
    '2.1',
    ['cancellation', 'rebooking', 'involuntary', 'all-tiers'],
    `When Qantas cancels a flight for any reason including operational, technical, weather, or Air Traffic Control, all customers regardless of fare class or QFF tier are entitled to: (1) rebooking on the next available Qantas or codeshare service at no additional charge, (2) a full refund to original payment method if the alternative offered is not acceptable, or (3) an open ticket valid for 12 months. Change fee and fare difference are both waived for airline-initiated cancellations. This policy supersedes all fare-class restrictions. Customers must be proactively notified via push notification, email, and SMS. Automated rebooking may be offered via the Qantas app using the AI-driven disruption orchestration system.`,
    {
      rebooking_options: ['next_available_qantas', 'codeshare', 'full_refund', 'open_ticket_12mo'],
      fees_waived: ['change_fee', 'fare_difference'],
      notification_channels: ['push', 'email', 'sms'],
    },
    ['Applies to all fares on Qantas-operated flights', 'Codeshare travel subject to operating carrier policy'],
    ['POL-DISR-002', 'POL-DISR-003']
  ),

  doc('POL-DISR-002', 'disruption', 'platinum_one', 'all',
    'Flight Cancellation — Platinum One Entitlements',
    '2.3',
    ['cancellation', 'platinum-one', 'priority', 'lounge'],
    `Platinum One members affected by Qantas-initiated flight cancellation receive the highest tier of disruption entitlements. In addition to the core rebooking right (POL-DISR-001), Platinum One members receive: priority confirmation on the first available Business or First class seat, dedicated Platinum One service line (13 13 13 Priority) with 0-minute wait time target, lounge access at the nearest Qantas Lounge or partner lounge for the duration of the disruption, meal and beverage allowance of AUD $75 per person (applied to Travel Bank automatically), hotel accommodation at a 4-star minimum if the disruption causes an overnight delay with transport to and from the hotel. A dedicated disruption concierge will proactively contact the customer within 15 minutes of the cancellation notification.`,
    {
      priority_class: 'first_available_J_or_F',
      meal_allowance_aud: 75,
      hotel_category: '4-star',
      hotel_eligible: true,
      lounge_access: true,
      service_line: '13 13 13 Priority',
      concierge_contact_sla_min: 15,
    },
    ['Must be travelling on a Qantas-operated service', 'Hotel accommodation at Qantas discretion for delays beyond midnight'],
    ['POL-DISR-001', 'POL-DISR-003', 'POL-LOUNGE-001']
  ),

  doc('POL-DISR-003', 'disruption', 'platinum', 'all',
    'Flight Cancellation — Platinum Entitlements',
    '2.1',
    ['cancellation', 'platinum', 'priority'],
    `Platinum members affected by Qantas-initiated flight cancellation receive: priority rebooking on next available Qantas or codeshare service (Business class confirmed where available), access to the Qantas Priority service line, lounge access during the delay at Qantas Lounge or partner lounge, meal and beverage allowance of AUD $50 per person applied to Travel Bank, hotel accommodation (3-star minimum) if the disruption causes an overnight delay with transport. Platinum members will receive a proactive notification and rebooking offer via the Qantas app within 20 minutes of cancellation being logged in the system.`,
    {
      priority_class: 'business_if_available',
      meal_allowance_aud: 50,
      hotel_category: '3-star',
      hotel_eligible: true,
      lounge_access: true,
      service_line: 'Priority Line',
    },
    ['Lounge access subject to lounge availability at origin airport'],
    ['POL-DISR-001', 'POL-DISR-002']
  ),

  doc('POL-DISR-004', 'disruption', 'gold', 'all',
    'Flight Cancellation — Gold Entitlements',
    '2.0',
    ['cancellation', 'gold'],
    `Gold members affected by Qantas-initiated cancellation receive: rebooking on next available service (same cabin class where available), meal voucher of AUD $30 per person issued at the airport or via digital wallet, lounge access for international disruptions when holding an international Business booking, hotel accommodation at standard category if overnight delay at Qantas discretion. Gold members receive rebooking notification within 30 minutes via the Qantas app or SMS.`,
    {
      meal_allowance_aud: 30,
      hotel_eligible: true,
      lounge_access_intl_business_only: true,
    },
    ['Domestic Gold disruptions: lounge access not included unless travelling Business'],
    ['POL-DISR-001']
  ),

  doc('POL-DISR-005', 'disruption', 'silver', 'all',
    'Flight Cancellation — Silver and Bronze Entitlements',
    '1.8',
    ['cancellation', 'silver', 'bronze'],
    `Silver and Bronze QFF members affected by Qantas-initiated cancellation receive the core entitlement under POL-DISR-001: rebooking on the next available service at no charge, or a full refund. No additional meal vouchers or accommodation are included at the discretionary tier, however hotel accommodation may be provided at Qantas discretion for delays causing overnight stays of more than 8 hours. Customers should approach the Qantas service desk at the airport or contact 13 13 13 for assistance.`,
    {
      meal_allowance_aud: 0,
      hotel_eligible: 'discretionary',
    },
    ['Applies to Silver and Bronze QFF members'],
    ['POL-DISR-001']
  ),

  // ── Delay entitlements by delay duration × tier (12 docs: 3 delay bands × 4 tier docs) ──

  doc('POL-DISR-006', 'disruption', 'all', 'all',
    'Flight Delay 2–4 Hours — Entitlements (All Tiers)',
    '1.5',
    ['delay', '2hr', 'voucher'],
    `For delays of 2 to 4 hours caused by Qantas (operational or technical): all passengers receive a light meal voucher of AUD $15 (domestic) or AUD $20 (international) redeemable at airport food outlets. Platinum One and Platinum members additionally receive complimentary lounge access if a Qantas Lounge is present at the departure airport. Vouchers are automatically issued to the Qantas app wallet within 30 minutes of the delay being confirmed in the operations system.`,
    { voucher_domestic_aud: 15, voucher_intl_aud: 20, lounge_platinum_and_above: true },
    ['Applies only to Qantas-caused delays, not weather or ATC'],
    ['POL-DISR-007', 'POL-DISR-008']
  ),

  doc('POL-DISR-007', 'disruption', 'all', 'all',
    'Flight Delay 4–8 Hours — Entitlements (All Tiers)',
    '1.5',
    ['delay', '4hr', 'meal'],
    `For Qantas-caused delays of 4 to 8 hours: all passengers receive a full meal voucher of AUD $30 (domestic) or AUD $40 (international). Platinum One receive AUD $75 and lounge access. Platinum receive AUD $50 and lounge access. Gold receive AUD $30 and international lounge access for international delays. Silver and Bronze receive the standard voucher. For delays beyond 6 hours, customers may request rebooking on an alternative service at no charge. Vouchers are applied to Travel Bank for app users automatically.`,
    {
      voucher_standard_domestic_aud: 30,
      voucher_standard_intl_aud: 40,
      voucher_platinum_one_aud: 75,
      voucher_platinum_aud: 50,
      lounge_platinum_and_above: true,
      rebooking_eligible_after_hours: 6,
    },
    ['Qantas-caused delays only'],
    ['POL-DISR-006', 'POL-DISR-008']
  ),

  doc('POL-DISR-008', 'disruption', 'all', 'all',
    'Flight Delay 8–12 Hours — Entitlements (All Tiers)',
    '1.6',
    ['delay', '8hr', 'hotel'],
    `For Qantas-caused delays of 8 to 12 hours: all passengers are entitled to hotel accommodation (or equivalent rest facility) if the delay extends into night hours (between 22:00 and 06:00). Meal allowances are AUD $50 (standard), AUD $100 (Platinum One), AUD $75 (Platinum), AUD $50 (Gold). Return transport between the airport and hotel is provided by Qantas. Passengers may alternatively choose a full refund if the delay is unacceptable.`,
    {
      hotel_eligible: true,
      transport_provided: true,
      meal_standard_aud: 50,
      meal_platinum_one_aud: 100,
      meal_platinum_aud: 75,
      meal_gold_aud: 50,
    },
    ['Hotel at Qantas discretion — 3-star standard, 4-star for Platinum and above'],
    ['POL-DISR-007', 'POL-DISR-009']
  ),

  doc('POL-DISR-009', 'disruption', 'all', 'all',
    'Flight Delay 12 Hours or More — Entitlements (All Tiers)',
    '1.7',
    ['delay', '12hr', 'overnight'],
    `For Qantas-caused delays of 12 hours or more, all passengers receive: full hotel accommodation regardless of time of day, AUD $100 (standard) / AUD $150 (Platinum One) / AUD $100 (Platinum) total meal allowance, transport to and from hotel, confirmed rebooking on the next available service with priority by tier. Platinum One and Platinum may request complimentary upgrade if available on the rebooked service. All passengers retain the option of a full refund.`,
    {
      hotel_guaranteed: true,
      meal_standard_aud: 100,
      meal_platinum_one_aud: 150,
      upgrade_option_available: ['platinum_one', 'platinum'],
    },
    ['Applies to Qantas-operated flights', 'Upgrade subject to availability'],
    ['POL-DISR-008']
  ),

  doc('POL-DISR-010', 'disruption', 'all', 'all',
    'Flight Diversion — Passenger Entitlements',
    '1.4',
    ['diversion', 'unplanned'],
    `When a Qantas flight is diverted to an unplanned destination: passengers are entitled to ground transportation to the original destination or return to origin at Qantas cost. Meals and refreshments will be provided during the wait. If diversion results in an overnight stay, hotel accommodation will be provided at Qantas cost for all passengers. Passengers may accept a refund if they choose not to continue travel. Platinum One and Platinum passengers will receive priority ground transport and are entitled to lounge or equivalent facility access if available.`,
    { transport_provided: true, hotel_eligible: true, refund_option: true },
    ['Applies to Qantas-operated flights QF series and QantasLink'],
    ['POL-DISR-001']
  ),

  doc('POL-DISR-011', 'disruption', 'all', 'all',
    'Denied Boarding — Involuntary Compensation (IATA 735d)',
    '2.0',
    ['denied-boarding', 'involuntary', 'compensation', 'IATA'],
    `Involuntary denied boarding occurs when a customer with a confirmed reservation is refused carriage. Per IATA Resolution 735d and ACCC guidelines: compensation of AUD $600–$1,200 depending on flight duration, immediate rebooking on next available service, refund option, meals and refreshments, and hotel accommodation if overnight. Compensation amounts: domestic flights under 2,500km — AUD $600; international flights — AUD $1,200. Compensation is paid as Travel Bank credit or cheque within 5 business days. Voluntary bumping incentives must be offered before invoking involuntary denied boarding.`,
    {
      compensation_domestic_aud: 600,
      compensation_intl_aud: 1200,
      voluntary_bump_offered_first: true,
      payment_methods: ['travel_bank', 'cheque'],
      payment_sla_days: 5,
    },
    ['IATA Resolution 735d compliance mandatory', 'ACCC guidelines apply for Australian domestic routes'],
    ['POL-DISR-001']
  ),

  doc('POL-DISR-012', 'disruption', 'all', 'all',
    'Downgrade — Compensation and Entitlements',
    '1.9',
    ['downgrade', 'involuntary', 'compensation'],
    `When a passenger is downgraded involuntarily from a higher to a lower cabin class: Qantas will refund the fare difference between the booked and travelled class within 10 business days to the original payment method. Business to Economy: 75% fare difference refunded. Premium Economy to Economy: 50% fare difference refunded. First to Business: 50% fare difference. Platinum One customers affected by downgrade receive an additional AUD $200 service recovery credit to Travel Bank. All downgraded passengers retain entitlements of their booked cabin class for lounge access.`,
    {
      refund_J_to_Y_pct: 75,
      refund_PE_to_Y_pct: 50,
      refund_F_to_J_pct: 50,
      platinum_one_recovery_credit_aud: 200,
      lounge_access_retained: true,
      refund_sla_days: 10,
    },
    ['Refund to original payment method only', 'Lounge access retained for booked cabin class'],
    ['POL-DISR-001', 'POL-LOUNGE-001']
  ),

  // ── Additional disruption policy docs ──

  doc('POL-DISR-013', 'disruption', 'all', 'all',
    'Disruption Notification Standards — Proactive Communication',
    '1.3',
    ['notification', 'proactive', 'communication'],
    `Qantas proactive disruption notifications must be issued within 30 minutes of a disruption being logged. Notification channels: push notification (Qantas app), email, and SMS. For disruptions more than 72 hours in advance: notification within 2 hours. For same-day disruptions: within 15 minutes. Platinum One and Platinum members receive a direct phone callback within 15 minutes for same-day disruptions. Notifications must include: new flight options, entitlements applicable to the customer's tier, and a direct link to self-serve rebooking.`,
    {
      notification_sla_same_day_min: 15,
      notification_sla_advance_hours: 2,
      platinum_callback_sla_min: 15,
      channels: ['push', 'email', 'sms', 'phone_platinum'],
    },
    ['Applies to all Qantas-operated flights'],
    ['POL-DISR-001']
  ),

  doc('POL-DISR-014', 'disruption', 'all', 'all',
    'Weather and ATC Disruption — Modified Entitlements',
    '1.2',
    ['weather', 'ATC', 'extraordinary'],
    `For disruptions caused by extraordinary circumstances (severe weather, ATC restrictions, national security events, pandemics) beyond Qantas control: rebooking entitlements remain in full under POL-DISR-001. Meal and accommodation entitlements are discretionary and subject to Qantas operational capacity at the disrupted station. Qantas will make reasonable endeavours to provide refreshments. Under Australian Consumer Law, discretionary entitlements do not apply for extraordinary circumstances, however Qantas commits to providing core rebooking and refund rights regardless of cause.`,
    { core_rebooking_retained: true, meal_accommodation_discretionary: true, acl_compliance: true },
    ['Weather and ATC disruptions are extraordinary circumstances under IATA 735d'],
    ['POL-DISR-001']
  ),

  doc('POL-DISR-015', 'disruption', 'all', 'all',
    'Self-Service Disruption Rebooking — Digital Channel Policy',
    '1.4',
    ['self-service', 'digital', 'app', 'rebooking'],
    `Customers may self-serve disruption rebooking via the Qantas app or qantas.com within 24 hours of the disruption notification. Available options: next available Qantas service, alternative routing via codeshare, travel credit, or full refund. Platinum One and Platinum members have access to exclusive alternative flight inventory via the app. Self-service rebooking is available for PNRs containing up to 9 passengers. Group bookings (10+) require agent assistance. The AI Disruption Assistant is available 24/7 within the app for guidance.`,
    { self_serve_window_hours: 24, max_pax_self_serve: 9, platinum_exclusive_inventory: true },
    ['Must hold confirmed reservation at time of disruption'],
    ['POL-DISR-001']
  ),

  // Docs 16–35 (remaining disruption — terse but complete)
  ...['POL-DISR-016', 'POL-DISR-017', 'POL-DISR-018', 'POL-DISR-019', 'POL-DISR-020'].map((id, i) => {
    const topics = [
      ['Technical Delay — Engineering Hold Policy', ['technical', 'MEL'], 'When a Minimum Equipment List (MEL) item grounds an aircraft, Qantas will endeavour to provide an alternative aircraft within 3 hours. If a replacement aircraft cannot be sourced within 3 hours, the delay triggers full delay entitlements under POL-DISR-006 through POL-DISR-009. Engineering holds are treated as airline-caused delays for entitlement purposes.', { alt_aircraft_target_hours: 3 }],
      ['Crew Shortage Delay Policy', ['crew', 'delay'], 'Crew duty time exceedances and crew shortages are treated as airline-caused disruptions for entitlement purposes. All delay entitlement tiers (POL-DISR-006 to POL-DISR-009) apply. Platinum One members receive priority crew reassignment notifications and dedicated rebooking support.', {}],
      ['International Disruption — Transit Passenger Entitlements', ['international', 'transit', 'connection'], 'Transit passengers whose connection is disrupted by a Qantas-caused delay or cancellation are entitled to: rebooking on next available connection, transit hotel if overnight wait required, meal allowances per tier, and expedited customs and immigration assistance at Qantas hub airports (SYD, MEL, BNE).', { transit_hotel_eligible: true }],
      ['Disruption — Connecting Non-Qantas Flights', ['connection', 'interline', 'codeshare'], 'When a Qantas delay causes a customer to miss a connection on a non-Qantas carrier: Qantas will rebook the Qantas segment and liaise with the connecting carrier. Entitlement to rebooking on the non-Qantas segment is governed by the interline agreement in effect. Qantas bears no liability for third-party carrier cancellation fees.', {}],
      ['Disruption — Unaccompanied Minor Protocol', ['unaccompanied-minor', 'UM', 'child'], 'Unaccompanied Minors (UM) affected by disruption must not be rebooked without parent or guardian consent. The Qantas UM desk must be notified within 30 minutes of the disruption. UM must remain in Qantas supervised care for the duration of the disruption. Priority rebooking applies regardless of QFF tier. Ground crew must maintain continuous supervision.', { guardian_consent_required: true, priority_rebooking: true }],
    ]
    const [title, tags, content, structured] = topics[i]
    return doc(id, 'disruption', 'all', 'all', title, '1.2', tags, content, structured, [], ['POL-DISR-001'])
  }),

  ...Array.from({ length: 20 }, (_, i) => {
    const id = `POL-DISR-0${21 + i}`
    const titles = [
      'Disruption Recovery — QFF Points Compensation',
      'Disruption — Checked Baggage Re-routing',
      'Proactive Disruption AI Orchestration Standards',
      'Disruption — Ancillary Service Refunds',
      'Disruption — Seat Assignment Reprotection',
      'Disruption — Medical Passenger Priority Rebooking',
      'Disruption — Frequent Flyer Status Credit Protection',
      'Disruption — Travel Insurance Qantas Assistance',
      'Disruption — International Codeshare Entitlements',
      'Disruption — Military and Government Fare Policy',
      'Disruption — Group Booking Rebooking Protocol',
      'Disruption — Pet In Cabin (PETC) Policy',
      'Disruption — Delayed Equipment — International Widebody',
      'Disruption — Tarmac Delay Passenger Rights',
      'Disruption — Post-Travel Service Recovery',
      'Disruption — Domestic Short-Haul Rebooking SLA',
      'Disruption — International Long-Haul Rebooking SLA',
      'Disruption — Strike and Industrial Action Policy',
      'Disruption — COVID and Pandemic Emergency Policy',
      'Disruption — Digital Self-Serve Escalation to Agent',
    ]
    return doc(id, 'disruption', 'all', 'all', titles[i], '1.1',
      ['disruption', 'policy'],
      `${titles[i]}: This policy governs Qantas disruption management procedures for ${titles[i].toLowerCase()}. Entitlements apply in accordance with the customer's QFF tier and fare class. All disruptions are logged in the E2E Journey Management orchestration system and tracked until resolution. Platinum One and Platinum members receive priority handling. The Single View of Policy (SVoP) provides agents with real-time entitlement lookup.`,
      {},
      ['Applies to Qantas-operated flights'],
      ['POL-DISR-001']
    )
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 2 — BAGGAGE (25 documents)
// ─────────────────────────────────────────────────────────────────────────────

const baggageDocs = [
  doc('POL-BAG-001', 'baggage', 'all', 'all',
    'Checked Baggage Allowance — Domestic (All Tiers)',
    '3.2',
    ['baggage', 'allowance', 'domestic'],
    `Qantas domestic checked baggage allowance by fare class and tier: Economy Saver — 23kg, Economy Flex — 23kg, Business — 32kg (2 pieces). QFF bonuses: Bronze +0kg, Silver +0kg, Gold +10kg, Platinum +10kg, Platinum One +20kg. Total maximum per piece: 32kg. Oversized items (sports equipment, musical instruments) subject to excess charges regardless of tier. Infants — 1 piece 10kg.`,
    {
      allowance_by_class: { economy: 23, business: 32 },
      tier_bonus_kg: { gold: 10, platinum: 10, platinum_one: 20 },
    },
    ['One bag per tier bonus, not per piece'],
    ['POL-BAG-002']
  ),

  doc('POL-BAG-002', 'baggage', 'all', 'all',
    'Checked Baggage Allowance — International (All Tiers)',
    '3.3',
    ['baggage', 'allowance', 'international'],
    `Qantas international checked baggage allowance: Economy — 30kg (1 piece), Premium Economy — 40kg (2 pieces), Business — 40kg (2 pieces), First — 50kg (3 pieces). QFF tier bonuses apply cumulatively: Gold +10kg, Platinum +20kg, Platinum One +30kg. Maximum piece weight 32kg. Excess baggage fees: AUD $35 per additional piece (domestic), AUD $75–$150 per additional piece international depending on destination zone.`,
    {
      allowance_by_class: { economy: '30kg 1pc', premium_economy: '40kg 2pc', business: '40kg 2pc', first: '50kg 3pc' },
      tier_bonus_kg: { gold: 10, platinum: 20, platinum_one: 30 },
    },
    ['Applicable to Qantas QF-coded flights'],
    ['POL-BAG-001']
  ),

  doc('POL-BAG-003', 'baggage', 'all', 'all',
    'Delayed Baggage — Compensation Entitlements by Tier',
    '3.0',
    ['baggage', 'delayed', 'compensation', 'tier'],
    `When a passenger's checked baggage does not arrive on the same service as the passenger, Qantas will: (1) issue a Property Irregularity Report (PIR), (2) trace the bag via the WorldTracer system, (3) deliver the bag to the passenger's address within 24 hours of location. Interim expense allowances by tier: Platinum One — AUD $500 (no receipts required), Platinum — AUD $400 (receipts required above AUD $50), Gold — AUD $300 (receipts required), Silver — AUD $200 (receipts required), Bronze — AUD $150 (receipts required). Allowance covers essential clothing, toiletries, and medication. Maximum claim period: 5 days of confirmed delay.`,
    {
      auto_approval_aud: { platinum_one: 500, platinum: 400, gold: 300, silver: 200, bronze: 150 },
      receipt_free_limit_aud: { platinum_one: 500, others: 50 },
      pir_required: true,
      bag_delivery_sla_hours: 24,
    },
    ['PIR must be lodged before leaving the baggage claim area', 'Allowance covers 5 days maximum'],
    ['POL-BAG-004']
  ),

  doc('POL-BAG-004', 'baggage', 'all', 'all',
    'Lost Baggage — Investigation and Compensation',
    '2.8',
    ['baggage', 'lost', 'compensation'],
    `Baggage is declared lost after 21 days of confirmed delayed status. Upon loss declaration: Qantas will offer compensation up to the Montreal Convention limits (approximately SDR 1,131 per passenger, approximately AUD $2,200). Platinum One and Platinum members may receive enhanced compensation up to AUD $3,500 subject to assessment. Customers with excess valuation declarations receive reimbursement to declared value. Claim documentation required: receipts for bag contents (up to 5 years old depreciated), original PIR number. Settlement within 30 business days.`,
    {
      montreal_convention_limit_sdr: 1131,
      montreal_approx_aud: 2200,
      enhanced_limit_platinum_aud: 3500,
      settlement_sla_days: 30,
      bag_declared_lost_days: 21,
    },
    ['Claims subject to Montreal Convention limits', 'Excess valuation requires pre-travel declaration'],
    ['POL-BAG-003', 'POL-BAG-005']
  ),

  doc('POL-BAG-005', 'baggage', 'all', 'all',
    'Damaged Baggage — Claim, Repair and Replacement',
    '2.5',
    ['baggage', 'damaged', 'repair', 'claim'],
    `Damaged baggage must be reported at the airport Baggage Services desk before leaving the terminal, or within 7 days for damage discovered post-travel. Qantas will: assess the damage, arrange repair by a Qantas approved repairer (free of charge), or replace with a comparable item if beyond repair. Replacement value based on depreciated cost. Wheels, handles, and minor scuffs are covered. Soft-sided bag tears covered. Pre-existing damage not covered. PIR required for all claims. Platinum One and Platinum members may use the dedicated Baggage Relations line for expedited processing within 24 hours.`,
    {
      reporting_window_days: 7,
      repair_service: 'approved_repairer',
      covered_damage: ['wheels', 'handles', 'tears'],
      excluded: ['pre-existing damage', 'minor scratches'],
    },
    ['Must report before leaving terminal for immediate damage', 'PIR required'],
    ['POL-BAG-003', 'POL-BAG-004']
  ),

  doc('POL-BAG-006', 'baggage', 'all', 'all',
    'Excess Baggage Fees — Domestic',
    '2.1',
    ['baggage', 'excess', 'domestic', 'fees'],
    `Domestic excess baggage charges: Additional piece (up to 23kg) — AUD $35 per sector. Oversized piece (>160cm total dimensions) — AUD $60 per sector. Overweight piece (>23kg up to 32kg) — AUD $25 per sector surcharge. Items exceeding 32kg are not accepted unless pre-arranged as cargo. QFF Gold and above receive 10kg additional allowance before excess applies. Prepaid excess baggage via the Qantas app is 20% cheaper than airport rates. Prepayment available up to 4 hours before departure.`,
    {
      additional_piece_aud: 35,
      oversized_aud: 60,
      overweight_surcharge_aud: 25,
      prepay_discount_pct: 20,
    },
    ['Maximum 2 excess pieces per passenger'],
    ['POL-BAG-001', 'POL-BAG-007']
  ),

  doc('POL-BAG-007', 'baggage', 'all', 'all',
    'Excess Baggage Fees — International',
    '2.2',
    ['baggage', 'excess', 'international', 'fees'],
    `International excess baggage charges by zone: Zone 1 (Trans-Tasman, Pacific) — AUD $80 per additional piece. Zone 2 (Asia, Americas) — AUD $100 per additional piece. Zone 3 (UK/Europe, Africa) — AUD $150 per additional piece. Additional pieces may be prepaid at a 25% discount via the Qantas website or app. Platinum One and Platinum One members with excess pieces pay no fee for first excess piece on international routes.`,
    {
      zone1_aud: 80, zone2_aud: 100, zone3_aud: 150,
      prepay_discount_pct: 25,
      platinum_one_free_pieces: 1,
    },
    ['Zone classification based on final international destination'],
    ['POL-BAG-002']
  ),

  doc('POL-BAG-008', 'baggage', 'all', 'all',
    'Sports Equipment — Acceptance and Fees',
    '1.9',
    ['baggage', 'sports', 'special-items'],
    `Sports equipment accepted by Qantas subject to packaging requirements and fees. Standard sports items (golf clubs, surfboards up to 2m, ski equipment, bicycles): AUD $40 per item domestic, AUD $70 per item international (Zone 1), AUD $100 (Zone 2-3). Items must be packed in appropriate cases. Bicycles must have pedals removed and handlebars turned. Surfboards require board bag. Maximum piece weight 32kg. Platinum One members receive one sports item included in their checked baggage allowance on domestic routes.`,
    { domestic_aud: 40, intl_zone1_aud: 70, intl_zone2_3_aud: 100, platinum_one_domestic_included: 1 },
    ['Must be appropriately packaged', 'Items over 32kg not accepted'],
    ['POL-BAG-001', 'POL-BAG-002']
  ),

  ...Array.from({ length: 17 }, (_, i) => {
    const id = `POL-BAG-${String(9 + i).padStart(3, '0')}`
    const titles = [
      'Cabin Baggage Allowance — All Cabins',
      'Baggage Tracking — WorldTracer Integration',
      'Fragile and Valuables Baggage Handling',
      'Musical Instruments — In-Cabin and Hold Policy',
      'Medicinal and Mobility Aids — Acceptance Policy',
      'Pet in Hold (AVIH) — Baggage Weight Exclusion',
      'Baggage — Prohibited and Restricted Items',
      'Baggage — Lithium Battery Restrictions',
      'Delayed Baggage — International Transit',
      'Baggage Claim Appeal Process',
      'Baggage — Premium Economy Allowance',
      'Baggage — QantasLink Turboprop Policy',
      'Baggage — Codeshare Most Restrictive Rule',
      'Baggage — Unaccompanied Minor Allowance',
      'Baggage — Infant Allowance',
      'Baggage — Infractions and Damage Assessment',
      'Baggage — Prepaid Service Terms',
    ]
    return doc(id, 'baggage', 'all', 'all', titles[i], '1.5',
      ['baggage', 'policy'],
      `${titles[i]}: Qantas policy governing ${titles[i].toLowerCase()}. All baggage policies align with IATA standards and Australian consumer law. Entitlements vary by QFF tier and fare class. Property Irregularity Reports (PIR) must be filed for all claims. The Qantas baggage portal provides 24/7 claim tracking.`,
      {},
      ['Subject to IATA Baggage Standards'],
      ['POL-BAG-001']
    )
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 3 — FLIGHT CHANGE (30 documents)
// ─────────────────────────────────────────────────────────────────────────────

const flightChangeDocs = [
  doc('POL-FC-0042', 'flight-change', 'all', 'all',
    'Voluntary Flight Change — Fee Matrix by Fare Class and Tier',
    '4.2',
    ['flight-change', 'fee', 'fare-class', 'tier'],
    `Qantas voluntary flight change fees are structured by fare class and QFF tier. Fee matrix (per passenger per change): Flex fares — AUD $0 for all tiers. Semi-Flex fares — Platinum One: AUD $0, Platinum: AUD $0, Gold: AUD $75, Silver: AUD $100, Bronze: AUD $100. Saver fares — Platinum One: AUD $0, Platinum: AUD $100, Gold: AUD $150, Silver: AUD $250, Bronze: AUD $250. Sale/Starter fares — changes not permitted for any tier; must purchase new ticket. Fare difference always payable in addition to change fee. Points tickets subject to separate schedule (POL-FC-0058).`,
    {
      change_fee_aud: {
        flex: { platinum_one: 0, platinum: 0, gold: 0, silver: 0, bronze: 0 },
        semi_flex: { platinum_one: 0, platinum: 0, gold: 75, silver: 100, bronze: 100 },
        saver: { platinum_one: 0, platinum: 100, gold: 150, silver: 250, bronze: 250 },
        sale: { all: 'not_permitted' },
      },
    },
    ['Fare difference payable regardless of tier', 'Sale and Starter fares non-changeable'],
    ['POL-FC-0043', 'POL-FC-0051']
  ),

  doc('POL-FC-0043', 'flight-change', 'all', 'all',
    'Voluntary Flight Change — International Fee Matrix',
    '4.0',
    ['flight-change', 'international', 'fee'],
    `International voluntary flight change fees: Flex — AUD $0 all tiers. Semi-Flex — Platinum One: AUD $0, Platinum: AUD $0, Gold: AUD $100, Silver: AUD $150, Bronze: AUD $150. Saver — Platinum One: AUD $0, Platinum: AUD $150, Gold: AUD $250, Silver: AUD $400, Bronze: AUD $400. Business Flex — AUD $0 all tiers. Business Saver — Platinum One: AUD $0, Platinum: AUD $0, Gold: AUD $200, Silver/Bronze: AUD $350. All fees are per passenger per change. Fare difference payable additionally.`,
    {
      change_fee_intl_aud: {
        flex: { all: 0 },
        semi_flex: { platinum_one: 0, platinum: 0, gold: 100, silver: 150, bronze: 150 },
        saver: { platinum_one: 0, platinum: 150, gold: 250, silver: 400, bronze: 400 },
        business_flex: { all: 0 },
        business_saver: { platinum_one: 0, platinum: 0, gold: 200, silver: 350, bronze: 350 },
      },
    },
    ['Applies to QF-coded international routes'],
    ['POL-FC-0042']
  ),

  doc('POL-FC-0051', 'flight-change', 'all', 'all',
    'Same-Day Flight Change — Policy and Fees',
    '1.3',
    ['same-day', 'flight-change', 'airport'],
    `Qantas same-day flight change allows customers to move to an earlier or later flight on the same day of travel. Available via Qantas app (up to 45 minutes before departure), airport kiosk, or service desk. Fee structure: Flex fares — AUD $0. Semi-Flex — AUD $0. Saver — AUD $50 surcharge in addition to any applicable change fee. No same-day changes for Sale/Starter. Platinum One and Platinum — same-day changes are free on all fare classes except Sale/Starter. Availability subject to seats on requested service; no guaranteed seat class upgrade via same-day change.`,
    {
      same_day_fee_saver_aud: 50,
      same_day_fee_flex_semi_flex_aud: 0,
      platinum_free: true,
      app_cutoff_min: 45,
    },
    ['Subject to seat availability on requested service'],
    ['POL-FC-0042']
  ),

  doc('POL-FC-0052', 'flight-change', 'all', 'flex',
    'Flex Fare — Change and Refund Terms',
    '2.1',
    ['flex', 'change', 'refund'],
    `Flex fare passengers may change to any Qantas service with availability at any time before departure at no change fee. Fare difference payable. Full refund available at any time to original payment method. Platinum One and Platinum Flex fare holders receive complimentary same-day change to Business on domestic routes if seats are available (subject to upgrade policy POL-UPG-003). Points earn is unrestricted on Flex fares.`,
    { change_fee_aud: 0, refund_permitted: true, same_day_upgrade_eligible: ['platinum_one', 'platinum'] },
    ['Fare difference always payable'],
    ['POL-FC-0042', 'POL-REF-001']
  ),

  doc('POL-FC-0053', 'flight-change', 'all', 'semi_flex',
    'Semi-Flex Fare — Change and Refund Terms',
    '2.0',
    ['semi-flex', 'change', 'refund'],
    `Semi-Flex fare passengers may change their flight before departure, subject to change fee by tier (see POL-FC-0042). Partial refund available: full refund minus AUD $50 cancellation fee. Travel credit valid 12 months if refund not requested. Platinum One and Platinum receive no change fee on Semi-Flex. Same-day changes permitted at the standard same-day fee.`,
    {
      cancellation_fee_aud: 50,
      credit_validity_months: 12,
      platinum_change_fee_aud: 0,
    },
    ['Credit valid 12 months from booking date'],
    ['POL-FC-0042', 'POL-REF-002']
  ),

  doc('POL-FC-0054', 'flight-change', 'all', 'saver',
    'Saver Fare — Change and Refund Terms',
    '2.0',
    ['saver', 'change', 'no-refund'],
    `Saver fare passengers may change their flight subject to the change fee matrix (POL-FC-0042). No cash refund for voluntary cancellation — travel credit only, valid 12 months. If Qantas cancels the flight (involuntary), full refund applies (POL-DISR-001). Platinum One change fee is AUD $0 on Saver domestic; AUD $0 international. Saver fares not eligible for complimentary upgrade.`,
    {
      refund_voluntary: 'credit_only',
      credit_validity_months: 12,
      refund_involuntary: 'full_refund_per_POL-DISR-001',
    },
    ['No cash refund for voluntary cancellation', 'Credit valid 12 months from original booking'],
    ['POL-FC-0042', 'POL-REF-003']
  ),

  ...Array.from({ length: 24 }, (_, i) => {
    const id = `POL-FC-${String(55 + i).padStart(4, '0')}`
    const titles = [
      'Sale/Starter Fare — No Change Policy',
      'Points Ticket Voluntary Change Fees',
      'Flight Change — Domestic vs International Rules',
      'Flight Change — Name Correction Policy',
      'Flight Change — Date of Travel Change (Open Date Ticket)',
      'Flight Change — Multi-City and Stopovers',
      'Flight Change — Codeshare and Partner Airline Segments',
      'Flight Change — Group Booking Change Policy',
      'Flight Change — Unaccompanied Minor Re-booking',
      'Flight Change — Medical and Compassionate Changes',
      'Flight Change — Infant and Child Fare Changes',
      'Flight Change — Frequent Flyer Status Credit Implications',
      'Flight Change — Business Fare Cabin Downgrade Rules',
      'Flight Change — First Class Re-accommodation',
      'Flight Change — QantasLink Regional Connections',
      'Flight Change — Holiday Package Component Changes',
      'Flight Change — Corporate Fare Agreement Modifications',
      'Flight Change — Round-the-World Fare Rules',
      'Flight Change — Interline Agreement Change Conditions',
      'Flight Change — Advance Purchase Restriction Waiver',
      'Flight Change — Travel Agent–Initiated Changes',
      'Flight Change — Third-Party Booking Platform Rules',
      'Flight Change — Expired Credit Reactivation Policy',
      'Flight Change — Booking Class Upgrade on Change',
    ]
    return doc(id, 'flight-change', 'all', 'all', titles[i], '1.2',
      ['flight-change', 'policy'],
      `${titles[i]}: Qantas policy governing ${titles[i].toLowerCase()}. This policy provides guidelines for ${titles[i].toLowerCase()} across all QFF tiers and fare classes. Entitlements vary by tier and fare class as outlined in the master change fee matrix (POL-FC-0042). The Qantas E2E Journey Management system manages change requests via the AI-driven journey orchestration layer.`,
      {},
      ['Subject to seat availability', 'Fare difference always payable'],
      ['POL-FC-0042']
    )
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 4 — REFUND (20 documents)
// ─────────────────────────────────────────────────────────────────────────────

const refundDocs = [
  doc('POL-REF-001', 'refund', 'all', 'flex',
    'Refund Entitlements — Flex Fare (All Tiers)',
    '2.0',
    ['refund', 'flex', 'all-tiers'],
    `Flex fare holders are entitled to a full refund to the original payment method at any time before departure, including after check-in. Refund processing time: 7 business days for credit cards, 10 days for Travel Bank. No cancellation fee applies. Airport taxes and carrier charges are refunded in full. QFF points taxes-only tickets refunded to card within 7 days; points returned to account within 24 hours.`,
    { refund_to_original: true, processing_days_card: 7, processing_days_travel_bank: 10, cancellation_fee_aud: 0 },
    ['Valid for all QFF tiers on Flex fares'],
    ['POL-REF-002']
  ),

  doc('POL-REF-002', 'refund', 'all', 'semi_flex',
    'Refund Entitlements — Semi-Flex Fare',
    '2.0',
    ['refund', 'semi-flex'],
    `Semi-Flex fare cancellations result in a refund of the ticket price minus AUD $50 cancellation fee, returned to the original payment method within 10 business days. Alternatively, the full ticket value may be held as Travel Bank credit valid for 12 months from original booking. The customer may select refund method online or via the Qantas contact centre. If the flight is cancelled by Qantas, a full refund with no deduction applies (POL-DISR-001).`,
    { cancellation_fee_aud: 50, credit_validity_months: 12, processing_days: 10 },
    ['Customer chooses refund or credit at time of cancellation'],
    ['POL-REF-001', 'POL-REF-003']
  ),

  doc('POL-REF-003', 'refund', 'all', 'saver',
    'Refund Entitlements — Saver Fare',
    '2.0',
    ['refund', 'saver', 'credit-only'],
    `Saver fare voluntary cancellations are entitled to Travel Bank credit only — no cash refund. Travel Bank credit is valid for 12 months from the original booking date. Credit is non-transferable and may only be used by the named passenger. If Qantas cancels the flight, full refund to original payment applies. No refund or credit for no-shows.`,
    { voluntary_refund: 'travel_bank_credit', credit_validity_months: 12, transferable: false },
    ['No cash refund for voluntary Saver cancellations', 'Credit non-transferable'],
    ['POL-REF-002']
  ),

  doc('POL-REF-004', 'refund', 'all', 'sale',
    'Refund Entitlements — Sale and Starter Fares',
    '2.0',
    ['refund', 'sale', 'no-refund'],
    `Sale and Starter fares are non-refundable and non-changeable. No cash refund or travel credit is issued for voluntary cancellations. Airport taxes and carrier charges are not refunded. Exception: if Qantas cancels the flight, a full refund to the original payment method is provided under POL-DISR-001. Medical and compassionate exceptions may be considered through the Customer Relations team for Platinum One and Platinum members only.`,
    { refund_voluntary: 'none', taxes_refunded: false, exception_tiers: ['platinum_one', 'platinum'] },
    ['No refund or credit on voluntary cancellation', 'Medical exceptions via Customer Relations only'],
    ['POL-REF-003']
  ),

  doc('POL-REF-005', 'refund', 'all', 'all',
    'QFF Points Ticket Cancellation and Refund',
    '1.8',
    ['refund', 'qff', 'points'],
    `QFF Classic and Points Plus Pay ticket cancellations: Points are credited back to the QFF account within 24 hours. Cash component (taxes, carrier charges) refunded to the original card within 7 business days. Change fee of AUD $50 applies for points tickets on Saver booking class (waived for Platinum One and Platinum). No-show forfeits points for Classic Economy Award.`,
    {
      points_return_hours: 24,
      cash_refund_days: 7,
      change_fee_aud: 50,
      change_fee_waived: ['platinum_one', 'platinum'],
      no_show_penalty: 'points_forfeited_classic_economy',
    },
    ['Points returned to account within 24 hours'],
    ['POL-REF-001']
  ),

  doc('POL-REF-006', 'refund', 'all', 'all',
    'Travel Bank Credit — Terms and Redemption',
    '1.6',
    ['refund', 'travel-bank', 'credit'],
    `Travel Bank credits issued as a result of cancellations are valid for 12 months from the issue date. Credits are applied automatically at time of booking. Credits are non-transferable to other passengers. Travel Bank credits may be used for flights, seat upgrades, and excess baggage prepayment but not for QFF points purchases. Expired credits cannot be reactivated (exception: Platinum One at Customer Relations discretion). Minimum credit use AUD $5.`,
    { validity_months: 12, transferable: false, uses: ['flights', 'seat_upgrades', 'baggage'], reactivation: 'platinum_one_discretionary' },
    ['Valid 12 months from issue', 'Non-transferable'],
    ['POL-REF-003']
  ),

  doc('POL-REF-007', 'refund', 'all', 'all',
    'Involuntary Refund — Airline-Initiated Cancellation',
    '2.1',
    ['refund', 'involuntary', 'cancellation'],
    `When Qantas cancels a flight for any reason, customers are entitled to a full refund to the original payment method including all taxes and charges. Refund is processed within 7 business days for card payments. Travel Bank refunds processed within 3 business days. QFF points credited within 24 hours. Refund may be declined in favour of rebooking at the customer's request. Platinum One members receive priority refund processing within 24 hours.`,
    { full_refund: true, processing_days_card: 7, processing_days_travel_bank: 3, platinum_one_priority_hours: 24 },
    ['Full refund including taxes for airline-initiated cancellation'],
    ['POL-REF-001', 'POL-DISR-001']
  ),

  doc('POL-REF-008', 'refund', 'all', 'all',
    'Medical and Compassionate Refund Policy',
    '1.5',
    ['refund', 'medical', 'compassionate'],
    `Customers who cannot travel due to serious illness, bereavement, or other compassionate circumstances may request a refund waiver through Qantas Customer Relations, regardless of fare class. Documentation required: medical certificate (doctor-signed) or death certificate. Refund issued as Travel Bank credit or, in exceptional cases, cash. Processing time 15 business days. Platinum One and Platinum members have access to a dedicated compassionate support team with 48-hour SLA. Annual limit of 2 compassionate waiver requests per QFF account.`,
    {
      documentation_required: ['medical_certificate', 'death_certificate'],
      refund_form: 'travel_bank_or_cash_exceptional',
      processing_days: 15,
      annual_limit: 2,
      platinum_sla_hours: 48,
    },
    ['Documentation must be provided within 30 days of travel date', 'Limit 2 per year per account'],
    ['POL-REF-003', 'POL-REF-004']
  ),

  ...Array.from({ length: 12 }, (_, i) => {
    const id = `POL-REF-${String(9 + i).padStart(3, '0')}`
    const titles = [
      'Refund Timeline Standards — All Fare Classes',
      'GST and Tax Refund Policy',
      'Refund — Package Holiday Component',
      'Refund — Corporate Account Credit Processing',
      'Refund — Third-Party Booking Refund Routing',
      'Refund — Multi-Currency Booking Policy',
      'Refund — Seat Selection Non-Refundability',
      'Refund — Upgrade Bid Non-Refundability',
      'Refund — Travel Insurance Premium Policy',
      'Refund — Ancillary Service Cancellation',
      'Refund — Group Booking Cancellation Terms',
      'Refund — Duplicate Booking Resolution',
    ]
    return doc(id, 'refund', 'all', 'all', titles[i], '1.3',
      ['refund', 'policy'],
      `${titles[i]}: Qantas refund policy covering ${titles[i].toLowerCase()}. Processing timelines, eligibility criteria, and customer tier entitlements are defined in this policy. Platinum One and Platinum members receive priority processing. All refunds comply with Australian Consumer Law and IATA standards.`,
      {},
      ['Subject to fare conditions at time of booking'],
      ['POL-REF-001']
    )
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 5 — LOUNGE (10 documents)
// ─────────────────────────────────────────────────────────────────────────────

const loungeDocs = [
  doc('POL-LOUNGE-001', 'lounge', 'platinum_one', 'all',
    'Lounge Access — Platinum One Entitlements',
    '3.1',
    ['lounge', 'platinum-one', 'access'],
    `Platinum One QFF members have unconditional access to all Qantas-operated domestic and international lounges when travelling on any Qantas or oneworld flight in any cabin. Additionally: access to the Qantas First Lounge (SYD, MEL, BNE) on any Qantas flight regardless of cabin. 2 complimentary guest passes per visit. Chairmans Lounge access is by Qantas invitation only and is separate from QFF tier entitlements. International Qantas lounges accessible on same-day travel.`,
    { domestic_access: true, intl_access: true, first_lounge: true, guest_passes: 2, chairmans_lounge: 'invitation_only' },
    ['Must be travelling on same-day Qantas or oneworld service'],
    ['POL-LOUNGE-002']
  ),

  doc('POL-LOUNGE-002', 'lounge', 'platinum', 'all',
    'Lounge Access — Platinum Entitlements',
    '3.0',
    ['lounge', 'platinum', 'access'],
    `Platinum QFF members are entitled to: access to all Qantas domestic lounges when travelling on any Qantas domestic flight, access to Qantas international lounges when travelling internationally on Qantas or oneworld, 1 complimentary guest pass per visit, access to Qantas Business Lounge at hub airports. No access to First Lounge unless travelling in First Class.`,
    { domestic_access: true, intl_access: true, first_lounge: 'first_class_only', guest_passes: 1 },
    ['International lounge requires same-day international travel on Qantas or oneworld'],
    ['POL-LOUNGE-001', 'POL-LOUNGE-003']
  ),

  doc('POL-LOUNGE-003', 'lounge', 'gold', 'all',
    'Lounge Access — Gold Entitlements',
    '2.8',
    ['lounge', 'gold', 'access'],
    `Gold QFF members are entitled to: access to Qantas domestic lounges when travelling on a Qantas domestic Business class ticket, access to Qantas international lounges when travelling internationally on Qantas or oneworld in Business or above. Economy Gold passengers do not receive domestic lounge access unless Business class ticket held. No guest passes for Gold tier in standard access.`,
    { domestic_access: 'business_class_only', intl_access: 'business_or_above', guest_passes: 0 },
    ['Domestic: Business class ticket required', 'International: Business class or above required'],
    ['POL-LOUNGE-002', 'POL-LOUNGE-004']
  ),

  doc('POL-LOUNGE-004', 'lounge', 'silver', 'all',
    'Lounge Access — Silver Entitlements',
    '2.5',
    ['lounge', 'silver', 'access'],
    `Silver QFF members are entitled to Qantas Club domestic lounge access when travelling on a Qantas domestic Business class ticket. No international lounge access as a Silver benefit. Silver members may purchase a Qantas Club day pass at the lounge reception for AUD $75 when not holding a qualifying ticket.`,
    { domestic_access: 'business_class_ticket_only', intl_access: false, day_pass_aud: 75 },
    ['Business class domestic ticket required for complimentary access'],
    ['POL-LOUNGE-003', 'POL-LOUNGE-005']
  ),

  doc('POL-LOUNGE-005', 'lounge', 'bronze', 'all',
    'Lounge Access — Bronze Entitlements and Day Pass',
    '2.3',
    ['lounge', 'bronze', 'day-pass'],
    `Bronze QFF members and non-QFF passengers do not receive complimentary lounge access. Options available: Qantas Club day pass — AUD $75 at the door or AUD $60 pre-purchased via the Qantas app. Qantas Club annual membership available for AUD $399 per year (individual) or AUD $699 (plus one). First Class ticket holders access the First Lounge regardless of QFF tier.`,
    { complimentary_access: false, day_pass_aud: 75, day_pass_app_aud: 60, annual_membership_aud: 399 },
    ['Day pass subject to lounge capacity', 'First class ticket overrides tier restriction'],
    ['POL-LOUNGE-004']
  ),

  doc('POL-LOUNGE-006', 'lounge', 'all', 'first',
    'Qantas First Lounge — Access Policy',
    '2.1',
    ['lounge', 'first', 'first-class'],
    `Qantas First Lounges (Sydney, Melbourne, Brisbane, Los Angeles) are accessible to: First Class passengers on same-day Qantas-operated flights, Platinum One members on any Qantas international flight, Chairmans Lounge members. Not accessible to Business class passengers regardless of tier (exception: Platinum One). No day pass or annual membership grants First Lounge access.`,
    { access: ['first_class_pax', 'platinum_one_intl', 'chairmans'] },
    ['Same-day Qantas flight required', 'Day passes not valid for First Lounge'],
    ['POL-LOUNGE-001']
  ),

  ...Array.from({ length: 4 }, (_, i) => {
    const id = `POL-LOUNGE-00${7 + i}`
    const titles = [
      'Lounge Access — Partner Airline and oneworld Reciprocal',
      'Lounge Access — Qantas Club Annual Membership Terms',
      'Lounge — Capacity Management and Overflow Policy',
      'Lounge — Children and Infant Access Policy',
    ]
    return doc(id, 'lounge', 'all', 'all', titles[i], '1.4',
      ['lounge', 'access'],
      `${titles[i]}: This policy governs ${titles[i].toLowerCase()} at Qantas lounges nationally and internationally. Access is determined by QFF tier, cabin class, and applicable agreements. The AI concierge within the Qantas app can confirm lounge eligibility in real time.`,
      {},
      ['Same-day travel required for all lounge access'],
      ['POL-LOUNGE-001']
    )
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 6 — LOYALTY / QFF (25 documents)
// ─────────────────────────────────────────────────────────────────────────────

const loyaltyDocs = Array.from({ length: 25 }, (_, i) => {
  const id = `POL-QFF-${String(1 + i).padStart(3, '0')}`
  const titles = [
    'QFF Points Earning — Economy Class by Tier',
    'QFF Points Earning — Business Class by Tier',
    'QFF Points Earning — First Class Multiplier',
    'Status Credits Earning — Domestic Flights',
    'Status Credits Earning — International Flights',
    'QFF Tier Qualification — Status Credit Thresholds',
    'QFF Points Redemption — Classic Flight Reward',
    'QFF Points Redemption — Points Plus Pay',
    'QFF Points Expiry Policy',
    'QFF Companion Fare — Platinum One Benefit',
    'QFF Points Earning — Partner Airlines (oneworld)',
    'QFF Earn on Non-Air Spend (Hotels, Car, Credit Card)',
    'QFF Status Extension and Requalification',
    'QFF Points — Transfer to Partner Programs',
    'QFF Points — Family Pooling',
    'QFF Tier — Lifetime Gold Status',
    'QFF — Points Bid Upgrade Earn',
    'QFF — Status Credits on Codeshare Segments',
    'QFF — Points Earn on Ancillary Purchases',
    'QFF — Corporate Points Earning',
    'QFF — Status Challenge Program',
    'QFF — Pro Rata Status Credits on Partial Journey',
    'QFF — Points Surcharge and Carrier Charges',
    'QFF — Retroactive Points Claim Policy',
    'QFF — Points Account Security Policy',
  ]
  const tiers = ['all', 'platinum_one', 'platinum', 'gold', 'silver', 'all', 'all', 'all', 'all', 'platinum_one']
  return doc(id, 'loyalty', tiers[i % tiers.length] || 'all', 'all', titles[i], '5.0',
    ['qff', 'loyalty', 'points'],
    `${titles[i]}: Qantas QFF policy governing ${titles[i].toLowerCase()}. Points and Status Credits are awarded according to the QFF earn rate schedule, which is updated annually. Platinum One members receive the highest earn multiplier across all sectors. Status Credits determine annual tier qualification. The QFF program is governed by the Qantas Frequent Flyer Terms and Conditions.`,
    {
      earn_multiplier: { platinum_one: 2.0, platinum: 1.75, gold: 1.5, silver: 1.25, bronze: 1.0 },
    },
    ['Subject to QFF Terms and Conditions', 'Earn rates reviewed annually'],
    ['POL-QFF-001']
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 7 — SPECIAL ASSISTANCE (10 documents)
// ─────────────────────────────────────────────────────────────────────────────

const specialAssistanceDocs = Array.from({ length: 10 }, (_, i) => {
  const id = `POL-SA-${String(1 + i).padStart(3, '0')}`
  const titles = [
    'Unaccompanied Minor (UM) — Booking and Acceptance Policy',
    'Unaccompanied Minor — In-Flight Supervision Standards',
    'Passenger with Disability — Wheelchair and Mobility Aid',
    'Passenger with Disability — Airport Assistance Protocol',
    'Medical Clearance — MEDIF Form Requirements',
    'Medical Clearance — Stretcher and Oxygen',
    'Passenger with Disability — Guide Dog Policy',
    'Passenger with Disability — Hearing and Visual Impairment',
    'Elderly Passenger — Assistance and Priority Services',
    'Special Dietary Requirements — Meal Request Policy',
  ]
  return doc(id, 'special-assistance', 'all', 'all', titles[i], '2.0',
    ['special-assistance', 'disability', 'UM'],
    `${titles[i]}: Qantas policy governing ${titles[i].toLowerCase()}. All special assistance requests must be made at least 48 hours before departure. Qantas is committed to providing accessible and inclusive travel for all passengers. Special assistance passengers receive priority boarding on all Qantas-operated services.`,
    { advance_notice_hours: 48, priority_boarding: true },
    ['Request must be lodged 48 hours in advance', 'Priority boarding on all Qantas services'],
    ['POL-SA-001']
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 8 — UPGRADES (10 documents)
// ─────────────────────────────────────────────────────────────────────────────

const upgradeDocs = Array.from({ length: 10 }, (_, i) => {
  const id = `POL-UPG-${String(1 + i).padStart(3, '0')}`
  const titles = [
    'Complimentary Upgrade — Priority Algorithm by Tier',
    'Complimentary Upgrade — Eligibility and Fare Class',
    'Points Upgrade — Classic Upgrade Award',
    'Points Upgrade — Points Plus Pay Upgrade',
    'Upgrade Bid — System and Pricing',
    'Upgrade — Platinum One Complimentary Entitlement',
    'Upgrade — Domestic vs International Policy',
    'Upgrade — Status Match on Upgrade Requests',
    'Upgrade — Companion Upgrade Entitlement',
    'Upgrade — Corporate Negotiated Upgrade Terms',
  ]
  return doc(id, 'upgrades', i === 5 ? 'platinum_one' : 'all', 'all', titles[i], '2.2',
    ['upgrade', 'complimentary', 'points'],
    `${titles[i]}: Qantas upgrade policy governing ${titles[i].toLowerCase()}. Complimentary upgrades are allocated by the automated priority engine in departure order, with Platinum One ranked first. Points upgrades require sufficient Classic Upgrade Award points and availability on the U class inventory. Upgrade bid results are notified 24 hours before departure.`,
    {
      priority_order: ['platinum_one', 'platinum', 'gold', 'silver', 'bronze'],
      bid_notification_hours: 24,
    },
    ['Subject to seat availability', 'Upgrade waives original class for lounge access only where specified'],
    ['POL-UPG-001']
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 9 — SEATING (15 documents)
// ─────────────────────────────────────────────────────────────────────────────

const seatingDocs = Array.from({ length: 15 }, (_, i) => {
  const id = `POL-SEAT-${String(1 + i).padStart(3, '0')}`
  const titles = [
    'Seat Selection — Advance Selection by Tier',
    'Seat Selection — Exit Row Policy',
    'Seat Selection — Companion Seating',
    'Seat Selection — Infant Bassinet Row',
    'Seat Selection — Preferred Seat Fees',
    'Seat Selection — Domestic Business Cabin',
    'Seat Selection — International Business Suite',
    'Seat Selection — Premium Economy Row Allocation',
    'Seat Selection — QFF Gold Complimentary Preferred Seat',
    'Seat Selection — Platinum One Open Seating',
    'Seat Selection — Codeshare Segment Rules',
    'Seat Selection — Group Booking Allocation',
    'Seat Selection — Aircraft Change Rebooking',
    'Seat Selection — Window vs Aisle Preference',
    'Seat Selection — Disability Seating Priority',
  ]
  return doc(id, 'seating', 'all', 'all', titles[i], '1.8',
    ['seating', 'seat-selection'],
    `${titles[i]}: Qantas seating policy governing ${titles[i].toLowerCase()}. Seat selection opens 12 months before departure for Platinum One, 9 months for Platinum, 6 months for Gold, 3 months for Silver/Bronze, and at time of booking for Flex fares. Preferred seats (extra legroom, window, exit row) are complimentary for Platinum One and Platinum. Gold members receive complimentary preferred seat selection on domestic routes.`,
    {
      selection_open_months: { platinum_one: 12, platinum: 9, gold: 6, silver: 3, bronze: 3 },
      preferred_seat_free: ['platinum_one', 'platinum'],
      gold_domestic_free: true,
    },
    ['Subject to aircraft type and availability'],
    ['POL-SEAT-001']
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Compile all 180 documents
// ─────────────────────────────────────────────────────────────────────────────

const ALL_POLICIES = [
  ...disruptionDocs,    // 35
  ...baggageDocs,       // 25
  ...flightChangeDocs,  // 30
  ...refundDocs,        // 20
  ...loungeDocs,        // 10
  ...loyaltyDocs,       // 25
  ...specialAssistanceDocs, // 10
  ...upgradeDocs,       // 10
  ...seatingDocs,       // 15
]

console.log(`[INFO] Total policy documents compiled: ${ALL_POLICIES.length}`)

if (ALL_POLICIES.length !== 180) {
  console.warn(`[WARN] Expected 180 documents, got ${ALL_POLICIES.length}. Adjust domain arrays.`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload to S3
// ─────────────────────────────────────────────────────────────────────────────

// S3 metadata headers only allow ASCII. Strip/replace non-ASCII characters.
function toAsciiMeta(obj) {
  const result = {}
  for (const [k, v] of Object.entries(obj)) {
    result[k] = String(v)
      .replace(/\u2014/g, '-')   // em dash → -
      .replace(/\u2013/g, '-')   // en dash → -
      .replace(/[\u2018\u2019]/g, "'") // curly single quotes → '
      .replace(/[\u201C\u201D]/g, '"') // curly double quotes → "
      .replace(/[^\x00-\x7F]/g, '')    // strip any remaining non-ASCII
  }
  return result
}

async function uploadAll() {
  let uploaded = 0
  let failed = 0

  for (const policy of ALL_POLICIES) {
    const key = `policies/${policy.domain}/${policy.id}.json`
    const body = JSON.stringify(policy, null, 2)

    process.stdout.write(`Uploading ${uploaded + 1}/${ALL_POLICIES.length}: ${policy.id} (${policy.domain})...`)

    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        Metadata: toAsciiMeta({
          policyId: policy.id,
          domain: policy.domain,
          tier: policy.tier,
          title: policy.title,
          version: policy.version,
          effective_date: policy.effective_date,
          tags: policy.tags.join(','),
        }),
      }))
      uploaded++
      console.log(' OK')
    } catch (err) {
      failed++
      console.log(` FAILED: ${err.message}`)
    }
  }

  console.log(`\n[INFO] Upload complete: ${uploaded} succeeded, ${failed} failed.`)
  return { uploaded, failed }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Bedrock KB sync
// ─────────────────────────────────────────────────────────────────────────────

async function triggerSync() {
  if (!KB_ID || !DS_ID) {
    console.log('[INFO] BEDROCK_KB_ID or BEDROCK_KB_DATA_SOURCE_ID not set — skipping KB sync.')
    console.log('[INFO] Run scripts/setup-aws-kb.sh first, then re-run this script to trigger sync.')
    return
  }

  console.log(`\n[INFO] Starting Bedrock KB ingestion job...`)
  try {
    const response = await bedrockAgent.send(new StartIngestionJobCommand({
      knowledgeBaseId: KB_ID,
      dataSourceId: DS_ID,
      description: `iQ SVoP policy seed — ${ALL_POLICIES.length} documents — ${new Date().toISOString()}`,
    }))
    const jobId = response.ingestionJob?.ingestionJobId ?? 'unknown'
    console.log(`✅ ${ALL_POLICIES.length} documents uploaded. Starting KB sync job: ${jobId}`)
    console.log(`[INFO] Monitor at: AWS Console → Amazon Bedrock → Knowledge Bases → ${KB_ID}`)
  } catch (err) {
    console.error(`[ERROR] Failed to start ingestion job: ${err.message}`)
    console.log('[INFO] You can trigger sync manually in the AWS Console.')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

;(async () => {
  console.log('=== iQ SVoP Policy Seed ===')
  console.log(`Bucket : ${BUCKET}`)
  console.log(`Region : ${REGION}`)
  console.log(`KB ID  : ${KB_ID || '(not set — sync will be skipped)'}`)
  console.log(`DS ID  : ${DS_ID || '(not set — sync will be skipped)'}`)
  console.log('')

  const { uploaded, failed } = await uploadAll()

  if (failed > 0) {
    console.warn(`[WARN] ${failed} uploads failed. Check AWS credentials and bucket permissions.`)
    process.exitCode = 1
  }

  await triggerSync()
})()
