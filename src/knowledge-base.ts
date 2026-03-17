/**
 * knowledge-base.ts
 * Bedrock Knowledge Base RAG integration for the Single View of Policy (SVoP).
 * When BEDROCK_KB_ID is not set the module returns realistic mock policy responses
 * so the service starts and responds correctly before AWS is provisioned.
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  RetrieveCommand,
  type RetrieveAndGenerateCommandInput,
  type RetrieveCommandInput,
  type RetrievalFilter,
} from '@aws-sdk/client-bedrock-agent-runtime'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueryContext {
  tier?: string
  domain?: string
  sessionId?: string
}

export interface PolicySource {
  policyId: string
  title: string
  domain: string
  relevanceScore: number
  excerpt: string
}

export interface PolicyDocument {
  id: string
  domain: string
  tier: string
  title: string
  summary: string
  tags: string[]
  version: string
  effectiveDate: string
}

export interface QueryResult {
  answer: string
  sources: PolicySource[]
  confidence: number
  executionMs: number
  source: 'bedrock-kb' | 'mock'
}

export interface ExplainResult {
  explanation: string
  applicableClauses: string[]
  policyRef: string
  source: 'bedrock-kb' | 'mock'
}

export interface SearchResult {
  results: PolicyDocument[]
  source: 'bedrock-kb' | 'mock'
}

// ─── Bedrock client (lazy init so service boots without AWS creds) ─────────────

let _client: BedrockAgentRuntimeClient | null = null

function getClient(): BedrockAgentRuntimeClient {
  if (!_client) {
    _client = new BedrockAgentRuntimeClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
    })
  }
  return _client
}

const KB_ID = process.env.BEDROCK_KB_ID
const MODEL_ARN = `arn:aws:bedrock:${process.env.AWS_REGION ?? 'us-east-1'}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`

// ─── Mock data ────────────────────────────────────────────────────────────────

const MOCK_POLICIES: Record<string, { answer: string; sources: PolicySource[]; confidence: number }> = {
  default: {
    answer:
      'Under Qantas policy POL-DISR-001, when a flight is cancelled by Qantas, all customers are entitled to rebooking on the next available Qantas or partner service at no additional charge. Platinum One and Platinum members receive priority rebooking with dedicated agent assistance and lounge access during delays exceeding 2 hours. Gold members receive meal vouchers for delays over 4 hours. All tiers are protected under IATA Resolution 735d.',
    sources: [
      {
        policyId: 'POL-DISR-001',
        title: 'Flight Cancellation — Rebooking Entitlements',
        domain: 'disruption',
        relevanceScore: 0.97,
        excerpt: 'All customers are entitled to rebooking at no additional cost when cancellation is airline-initiated.',
      },
      {
        policyId: 'POL-DISR-002',
        title: 'Involuntary Disruption — Tier-Based Entitlements',
        domain: 'disruption',
        relevanceScore: 0.91,
        excerpt: 'Platinum One customers receive confirmed first available seat, lounge access, and meal allowance AUD $75.',
      },
    ],
    confidence: 0.94,
  },
  disruption: {
    answer:
      'Qantas disruption policy (POL-DISR-001 through POL-DISR-012) provides the following rebooking entitlements by tier: Platinum One — waived change fees, priority rebooking, AUD $75 meal voucher, hotel accommodation if overnight delay, lounge access throughout. Platinum — waived change fees, priority queue, AUD $50 meal voucher, hotel if overnight. Gold — waived change fees, AUD $30 meal voucher. Silver and Bronze — waived change fees, standard queue. All tiers may request full refund to original payment method if alternative routing is unacceptable.',
    sources: [
      {
        policyId: 'POL-DISR-001',
        title: 'Flight Cancellation — Rebooking Entitlements',
        domain: 'disruption',
        relevanceScore: 0.98,
        excerpt: 'All customers are entitled to rebooking at no additional cost when cancellation is airline-initiated.',
      },
      {
        policyId: 'POL-DISR-003',
        title: 'Disruption — Meal and Accommodation Allowances',
        domain: 'disruption',
        relevanceScore: 0.95,
        excerpt: 'Meal vouchers are issued automatically at the airport or via digital wallet when delay exceeds 4 hours.',
      },
      {
        policyId: 'POL-DISR-005',
        title: 'Denied Boarding Compensation',
        domain: 'disruption',
        relevanceScore: 0.82,
        excerpt: 'Involuntary denied boarding triggers compensation per IATA Resolution 735d and ACCC guidelines.',
      },
    ],
    confidence: 0.96,
  },
  baggage: {
    answer:
      'Qantas baggage policy (POL-BAG-001 through POL-BAG-025) governs delayed, damaged and lost baggage claims. Auto-approval limits by tier: Platinum One — AUD $500, Platinum — AUD $400, Gold — AUD $300, Silver — AUD $200, Bronze — AUD $150. Claims above these thresholds require supervisor review. Damaged baggage must be reported at the airport before leaving the terminal or within 7 days for delayed items. PIR (Property Irregularity Report) number required for all claims. Repairs may be arranged through Qantas preferred repairers for full cost recovery.',
    sources: [
      {
        policyId: 'POL-BAG-003',
        title: 'Delayed Baggage — Compensation Entitlements by Tier',
        domain: 'baggage',
        relevanceScore: 0.97,
        excerpt: 'Platinum One customers may claim up to AUD $500 for delayed baggage expenses without receipts.',
      },
      {
        policyId: 'POL-BAG-007',
        title: 'Damaged Baggage — Claim and Repair Process',
        domain: 'baggage',
        relevanceScore: 0.93,
        excerpt: 'Damage must be reported at the airport before leaving the terminal or within 7 days for delayed baggage.',
      },
    ],
    confidence: 0.95,
  },
  'flight-change': {
    answer:
      'Qantas voluntary flight change policy (POL-FC-0042) sets fees by fare class and QFF tier. Flex fares: no change fee for all tiers. Semi-Flex: Platinum One and Platinum — waived, Gold — AUD $75, Silver/Bronze — AUD $100. Saver fares: Platinum One — waived, Platinum — AUD $100, Gold — AUD $150, Silver/Bronze — AUD $250. Sale/Starter fares: changes not permitted (rebook as new booking). Difference in fare must always be paid regardless of tier. Same-day changes at the airport incur a AUD $50 same-day fee for Saver and below.',
    sources: [
      {
        policyId: 'POL-FC-0042',
        title: 'Voluntary Flight Change — Fees by Fare Class',
        domain: 'flight-change',
        relevanceScore: 0.99,
        excerpt: 'Change fees are waived for Platinum One across all fare classes except Sale/Starter fares.',
      },
      {
        policyId: 'POL-FC-0051',
        title: 'Same-Day Flight Change Policy',
        domain: 'flight-change',
        relevanceScore: 0.88,
        excerpt: 'Same-day changes are available at the airport kiosk or via the Qantas app up to 45 minutes before departure.',
      },
    ],
    confidence: 0.97,
  },
  refund: {
    answer:
      'Qantas refund policy (POL-REF-001 through POL-REF-020) provides: Flex fares — full refund to original payment within 7 business days. Semi-Flex — refund minus AUD $50 cancellation fee. Saver fares — travel credit valid 12 months, no cash refund. Sale fares — no refund, no credit. QFF points tickets — points returned within 24 hours, taxes refunded to card within 7 days. Travel Bank credits refunded as Travel Bank. Platinum One and Platinum may request exceptions through the Priority Line for medical or compassionate circumstances.',
    sources: [
      {
        policyId: 'POL-REF-001',
        title: 'Refund Entitlements by Fare Class',
        domain: 'refund',
        relevanceScore: 0.97,
        excerpt: 'Flex fare holders are entitled to a full refund to the original payment method at any time before departure.',
      },
      {
        policyId: 'POL-REF-008',
        title: 'QFF Points Ticket Cancellation and Refund',
        domain: 'refund',
        relevanceScore: 0.91,
        excerpt: 'Points are credited back within 24 hours. Taxes and carrier charges are refunded within 7 business days.',
      },
    ],
    confidence: 0.93,
  },
  lounge: {
    answer:
      'Qantas lounge access policy (POL-LOUNGE-001 through POL-LOUNGE-010): Platinum One — unlimited international and domestic access, 2 guest passes per visit. Platinum — unlimited international and domestic access, 1 guest pass per visit. Gold — international lounge access when travelling on a Qantas international flight, domestic access on business class only. Silver — domestic lounge access on business class only. Bronze — no complimentary access, day pass available for AUD $75. Chairmans Lounge accessible only by invitation. International First Lounge available to Platinum One and First class passengers.',
    sources: [
      {
        policyId: 'POL-LOUNGE-001',
        title: 'Qantas Club and Lounge Access Entitlements',
        domain: 'lounge',
        relevanceScore: 0.98,
        excerpt: 'Platinum One members have unconditional lounge access at all Qantas operated domestic and international lounges.',
      },
    ],
    confidence: 0.96,
  },
}

function detectDomain(question: string): string {
  const q = question.toLowerCase()
  if (q.includes('cancel') || q.includes('disrupt') || q.includes('delay') || q.includes('diverted')) return 'disruption'
  if (q.includes('baggage') || q.includes('luggage') || q.includes('bag') || q.includes('lost') || q.includes('damaged')) return 'baggage'
  if (q.includes('change') || q.includes('reschedule') || q.includes('modify') || q.includes('amend')) return 'flight-change'
  if (q.includes('refund') || q.includes('cancel') || q.includes('credit') || q.includes('reimburse')) return 'refund'
  if (q.includes('lounge') || q.includes('chairman') || q.includes('club')) return 'lounge'
  return 'default'
}

function buildMockQueryResult(question: string, context: QueryContext): QueryResult {
  const domain = context.domain ?? detectDomain(question)
  const mock = MOCK_POLICIES[domain] ?? MOCK_POLICIES['default']
  return {
    answer: mock.answer,
    sources: mock.sources,
    confidence: mock.confidence,
    executionMs: 12,
    source: 'mock',
  }
}

function buildMockExplainResult(policyId: string): ExplainResult {
  const policyMap: Record<string, ExplainResult> = {
    'POL-DISR-001': {
      explanation:
        'This policy applies when Qantas initiates a flight cancellation for any reason including operational, technical, or weather. The policy supersedes any fare-class restrictions and guarantees the customer the right to rebooking or full refund. Tier determines speed of service and entitlements (meals, accommodation) but all tiers receive the core protection.',
      applicableClauses: [
        'Clause 3.1 — Rebooking right applies to all fares irrespective of restrictions',
        'Clause 3.2 — Customer may choose alternative routing or full refund',
        'Clause 3.4 — Hotel accommodation provided for delays beyond midnight at Qantas discretion',
        'Clause 4.1 — Tier-based entitlements overlay the base rebooking right',
      ],
      policyRef: 'POL-DISR-001 v2.1 — effective 1 Jan 2026',
      source: 'mock',
    },
    'POL-BAG-003': {
      explanation:
        'Delayed baggage compensation allows customers to claim reasonable expenses incurred while awaiting their bags. The auto-approval thresholds are set per tier to reduce friction for high-value customers. Claims above the threshold are queued for supervisor review with a 4-hour SLA. Receipts are required for all claims above AUD $50 except Platinum One who may self-declare up to their tier limit.',
      applicableClauses: [
        'Clause 2.1 — Delayed baggage defined as bag not received within 4 hours of arrival',
        'Clause 2.3 — Auto-approval limits by tier: Platinum One $500, Platinum $400, Gold $300, Silver $200, Bronze $150',
        'Clause 2.5 — Receipts required for all claims over $50 (Platinum One exempt up to $500)',
        'Clause 3.1 — PIR number required for all claims',
      ],
      policyRef: 'POL-BAG-003 v3.0 — effective 1 Jan 2026',
      source: 'mock',
    },
    'POL-FC-0042': {
      explanation:
        'Voluntary flight change fees are structured to reward loyalty tier and higher fare classes. The policy creates a clear price signal: higher fares and higher tiers attract lower or zero fees. Platinum One are fee-exempt on all fare classes except Sale/Starter which are non-changeable. The fare difference always applies — fee waiver covers only the change fee, not any uplift in fare.',
      applicableClauses: [
        'Clause 1.1 — Change fee applies per passenger per change',
        'Clause 1.2 — Fare difference payable in addition to any change fee',
        'Clause 1.3 — Platinum One: fees waived on Flex, Semi-Flex, and Saver',
        'Clause 1.4 — Sale/Starter fares: changes not permitted for any tier',
        'Clause 2.1 — Same-day change fee AUD $50 applies at airport for Saver and below',
      ],
      policyRef: 'POL-FC-0042 v4.2 — effective 1 Jan 2026',
      source: 'mock',
    },
  }

  return (
    policyMap[policyId] ?? {
      explanation: `Policy ${policyId} provides structured entitlements aligned to Qantas QFF tier and fare class. The policy is administered through the Single View of Policy (SVoP) platform and is retrievable in real time by all Qantas digital channels.`,
      applicableClauses: [
        'Clause 1.1 — Policy applies to all Qantas-operated flights',
        'Clause 1.2 — Tier entitlements override standard fare restrictions where specified',
        'Clause 1.3 — Policy administered by Revenue Management and Customer Relations',
      ],
      policyRef: `${policyId} — effective 1 Jan 2026`,
      source: 'mock',
    }
  )
}

const MOCK_SEARCH_CATALOGUE: PolicyDocument[] = [
  { id: 'POL-DISR-001', domain: 'disruption', tier: 'all', title: 'Flight Cancellation — Rebooking Entitlements', summary: 'Core policy for airline-initiated cancellations', tags: ['cancellation', 'rebooking'], version: '2.1', effectiveDate: '2026-01-01' },
  { id: 'POL-DISR-002', domain: 'disruption', tier: 'all', title: 'Involuntary Disruption — Tier Entitlements', summary: 'Tier-specific entitlements for disruption events', tags: ['disruption', 'tier'], version: '1.8', effectiveDate: '2026-01-01' },
  { id: 'POL-BAG-003', domain: 'baggage', tier: 'all', title: 'Delayed Baggage Compensation', summary: 'Auto-approval limits and claim process for delayed bags', tags: ['baggage', 'delay', 'compensation'], version: '3.0', effectiveDate: '2026-01-01' },
  { id: 'POL-BAG-007', domain: 'baggage', tier: 'all', title: 'Damaged Baggage — Claim and Repair', summary: 'Reporting obligations and repair/replacement process', tags: ['baggage', 'damage'], version: '2.5', effectiveDate: '2026-01-01' },
  { id: 'POL-FC-0042', domain: 'flight-change', tier: 'all', title: 'Voluntary Flight Change Fees by Fare Class', summary: 'Change fee matrix by tier and fare class', tags: ['change', 'fee', 'fare-class'], version: '4.2', effectiveDate: '2026-01-01' },
  { id: 'POL-FC-0051', domain: 'flight-change', tier: 'all', title: 'Same-Day Flight Change Policy', summary: 'Same-day change process and applicable fees', tags: ['same-day', 'change'], version: '1.3', effectiveDate: '2026-01-01' },
  { id: 'POL-REF-001', domain: 'refund', tier: 'all', title: 'Refund Entitlements by Fare Class', summary: 'Cash refund and travel credit matrix', tags: ['refund', 'cancellation'], version: '2.0', effectiveDate: '2026-01-01' },
  { id: 'POL-LOUNGE-001', domain: 'lounge', tier: 'all', title: 'Lounge Access Entitlements', summary: 'Tier-based lounge access rights domestic and international', tags: ['lounge', 'access', 'tier'], version: '3.1', effectiveDate: '2026-01-01' },
  { id: 'POL-QFF-001', domain: 'loyalty', tier: 'all', title: 'QFF Points Earning by Tier and Cabin', summary: 'Points and status credit earn rates', tags: ['qff', 'points', 'earning'], version: '5.0', effectiveDate: '2026-01-01' },
  { id: 'POL-UPG-001', domain: 'upgrades', tier: 'all', title: 'Complimentary Upgrade Priority Order', summary: 'Upgrade priority algorithm and eligibility', tags: ['upgrade', 'complimentary'], version: '2.2', effectiveDate: '2026-01-01' },
]

function buildMockSearchResult(q: string, domain?: string, tier?: string): SearchResult {
  let results = MOCK_SEARCH_CATALOGUE
  if (domain) results = results.filter(p => p.domain === domain)
  if (tier) results = results.filter(p => p.tier === 'all' || p.tier === tier)
  if (q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    results = results.filter(p =>
      terms.some(
        term =>
          p.title.toLowerCase().includes(term) ||
          p.summary.toLowerCase().includes(term) ||
          p.tags.some(t => t.includes(term)) ||
          p.id.toLowerCase().includes(term),
      ),
    )
  }
  return { results: results.slice(0, 10), source: 'mock' }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function queryKnowledgeBase(question: string, context: QueryContext = {}): Promise<QueryResult> {
  if (!KB_ID) {
    return buildMockQueryResult(question, context)
  }

  const start = Date.now()
  const client = getClient()

  const input: RetrieveAndGenerateCommandInput = {
    input: { text: question },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KB_ID,
        modelArn: MODEL_ARN,
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 5,
            ...(context.domain
              ? {
                  filter: {
                    equals: { key: 'domain', value: context.domain },
                  },
                }
              : {}),
          },
        },
        generationConfiguration: {
          promptTemplate: {
            textPromptTemplate: `You are the Qantas Single View of Policy (SVoP) assistant. Answer the following question about Qantas policy based only on the retrieved policy documents. Be precise and include policy reference numbers. Customer tier: ${context.tier ?? 'unknown'}.\n\n$search_results$\n\nQuestion: $query$`,
          },
          inferenceConfig: {
            textInferenceConfig: {
              temperature: 0.0,
              topP: 0.9,
              maxTokens: 800,
            },
          },
        },
      },
    },
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  }

  const cmd = new RetrieveAndGenerateCommand(input)
  const response = await client.send(cmd)

  const answer = response.output?.text ?? ''
  const citations = response.citations ?? []

  const sources: PolicySource[] = citations.flatMap(c =>
    (c.retrievedReferences ?? []).map(ref => ({
      policyId: (ref.metadata?.['policyId'] as string | undefined) ?? 'UNKNOWN',
      title: (ref.metadata?.['title'] as string | undefined) ?? 'Policy Document',
      domain: (ref.metadata?.['domain'] as string | undefined) ?? 'general',
      relevanceScore: 0.9,
      excerpt: ref.content?.text?.slice(0, 200) ?? '',
    })),
  )

  return {
    answer,
    sources,
    confidence: sources.length > 0 ? 0.92 : 0.6,
    executionMs: Date.now() - start,
    source: 'bedrock-kb',
  }
}

export async function explainPolicy(policyId: string, scenario: object): Promise<ExplainResult> {
  if (!KB_ID) {
    return buildMockExplainResult(policyId)
  }

  const start = Date.now()
  const client = getClient()
  const scenarioText = JSON.stringify(scenario, null, 2)
  const question = `Explain how policy ${policyId} applies to the following scenario and list the specific clauses that are triggered:\n${scenarioText}`

  const input: RetrieveAndGenerateCommandInput = {
    input: { text: question },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KB_ID,
        modelArn: MODEL_ARN,
        retrievalConfiguration: {
          vectorSearchConfiguration: { numberOfResults: 3 },
        },
      },
    },
  }

  const cmd = new RetrieveAndGenerateCommand(input)
  const response = await client.send(cmd)

  const explanation = response.output?.text ?? ''

  return {
    explanation,
    applicableClauses: [],
    policyRef: `${policyId} — retrieved from Bedrock KB`,
    source: 'bedrock-kb',
  }
}

export async function searchPolicies(q: string, domain?: string, tier?: string): Promise<SearchResult> {
  if (!KB_ID) {
    return buildMockSearchResult(q, domain, tier)
  }

  const start = Date.now()
  const client = getClient()

  const filters: RetrievalFilter[] = []
  if (domain) filters.push({ equals: { key: 'domain', value: domain } })
  if (tier) filters.push({ in: { key: 'tier', value: ['all', tier] } })

  let combinedFilter: RetrievalFilter | undefined
  if (filters.length === 1) {
    combinedFilter = filters[0]
  } else if (filters.length > 1) {
    combinedFilter = { andAll: filters }
  }

  const input: RetrieveCommandInput = {
    knowledgeBaseId: KB_ID,
    retrievalQuery: { text: q || `policies for domain ${domain ?? 'all'}` },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 10,
        ...(combinedFilter ? { filter: combinedFilter } : {}),
      },
    },
  }

  const cmd = new RetrieveCommand(input)
  const response = await client.send(cmd)

  const results: PolicyDocument[] = (response.retrievalResults ?? []).map(r => ({
    id: (r.metadata?.['policyId'] as string | undefined) ?? 'UNKNOWN',
    domain: (r.metadata?.['domain'] as string | undefined) ?? domain ?? 'general',
    tier: (r.metadata?.['tier'] as string | undefined) ?? 'all',
    title: (r.metadata?.['title'] as string | undefined) ?? 'Policy Document',
    summary: r.content?.text?.slice(0, 150) ?? '',
    tags: ((r.metadata?.['tags'] as string | undefined) ?? '').split(',').filter(Boolean),
    version: (r.metadata?.['version'] as string | undefined) ?? '1.0',
    effectiveDate: (r.metadata?.['effective_date'] as string | undefined) ?? '2026-01-01',
  }))

  return { results, source: 'bedrock-kb' }
}
