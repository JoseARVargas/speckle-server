import Anthropic from '@anthropic-ai/sdk'
import cryptoRandomString from 'crypto-random-string'
import { z } from 'zod'
import type { Knex } from 'knex'
import { BadRequestError } from '@/modules/shared/errors'
import {
  getAssetByIdFactory,
  listAssetsFactory
} from '@/modules/facilities/repositories/facilities'
import {
  listHealthSignalsByAssetFactory,
  listHealthSignalsByFacilityFactory,
  insertMaintenanceReportFactory
} from '@/modules/facilities/repositories/health'
import type {
  DeviceHealthSignalRecord,
  MaintenanceReportRecord
} from '@/modules/facilities/helpers/types'

const ReportSchema = z.object({
  summary: z.string().describe('2-4 sentences in plain language, no jargon dump'),
  recommendation: z
    .string()
    .describe('A single prioritized, actionable next step - what to do and why'),
  severity: z.enum(['info', 'warning', 'critical'])
})

const SYSTEM_PROMPT = `You write short predictive-maintenance reports for building operations staff, from structured anomaly-detection output about HVAC equipment - never from raw sensor time-series (you are never given any).

Each input item is one metric's current statistical state for one device: a trend (rising/falling/stable), a severity already computed by a z-score/regression detector (info/warning/critical), a z-score, and how long that state has held ("since"). Your job is interpretation, not detection - the anomaly detection already happened upstream.

Write for a facilities technician who is not a data scientist: plain language, no statistics jargon (don't say "z-score" or "regression" in the output), and ground the interpretation in what the underlying physical fault plausibly is (e.g. sustained high compressor duty with rising current can mean refrigerant loss or a dirty filter; a shrinking startup current spike suggests a worn starting capacitor). If every signal is stable/info, say so plainly and don't invent a problem. Pick one dominant issue to lead with if there are several - don't just list every signal back.

The report's own severity should reflect the worst signal severity present, unless the combination of signals suggests otherwise.

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly this shape:
{"summary": string, "recommendation": string, "severity": "info" | "warning" | "critical"}`

function formatSignals(
  signals: DeviceHealthSignalRecord[],
  assetLabel?: (assetId: string) => string
): string {
  if (!signals.length) return '[]'
  return JSON.stringify(
    signals.map((s) => ({
      ...(assetLabel ? { device: assetLabel(s.assetId) } : {}),
      metric: s.metric,
      trend: s.trend,
      severity: s.severity,
      zScore: Number(s.zScore.toFixed(2)),
      since: s.since.toISOString()
    })),
    null,
    2
  )
}

/**
 * Generates a maintenance report from already-computed health signals
 * (never raw telemetry) for either a single asset (`assetId` set) or a
 * facility-wide aggregate across every asset with signals (`assetId` null).
 */
export const generateMaintenanceReportFactory =
  (deps: { db: Knex; anthropicApiKey: string | undefined }) =>
  async (params: {
    projectId: string
    facilityId: string
    assetId: string | null
    userId: string | null
  }): Promise<MaintenanceReportRecord> => {
    if (!deps.anthropicApiKey) {
      throw new BadRequestError(
        'Predictive maintenance reports require ANTHROPIC_API_KEY to be configured on the server'
      )
    }

    let signals: DeviceHealthSignalRecord[]
    let promptInput: string
    let deviceContext: string

    if (params.assetId) {
      const asset = await getAssetByIdFactory({ db: deps.db })({ id: params.assetId })
      if (!asset) throw new BadRequestError('Asset not found')
      signals = await listHealthSignalsByAssetFactory({ db: deps.db })({
        assetId: params.assetId
      })
      deviceContext = `Single device: "${asset.tagNumber}"${
        asset.name ? ` (${asset.name})` : ''
      }.`
      promptInput = formatSignals(signals)
    } else {
      const assets = await listAssetsFactory({ db: deps.db })({
        facilityId: params.facilityId,
        limit: 500
      })
      const labels = new Map(
        assets.map((a) => [a.id, a.name ? `${a.tagNumber} (${a.name})` : a.tagNumber])
      )
      signals = await listHealthSignalsByFacilityFactory({ db: deps.db })({
        assetIds: assets.map((a) => a.id)
      })
      deviceContext = `Facility-wide report across ${assets.length} device(s).`
      promptInput = formatSignals(signals, (assetId) => labels.get(assetId) ?? assetId)
    }

    const client = new Anthropic({ apiKey: deps.anthropicApiKey })
    /* eslint-disable camelcase -- this is the Anthropic SDK's own wire-format param name */
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${deviceContext}\n\nCurrent health signals:\n${promptInput}`
        }
      ]
    })
    /* eslint-enable camelcase */

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    )
    const parsed = textBlock
      ? ReportSchema.safeParse(tryParseJson(textBlock.text))
      : null
    if (!parsed?.success) {
      throw new BadRequestError(
        'The maintenance report model did not return a valid report'
      )
    }

    const report: MaintenanceReportRecord = {
      id: cryptoRandomString({ length: 10 }),
      projectId: params.projectId,
      facilityId: params.facilityId,
      assetId: params.assetId,
      summary: parsed.data.summary,
      recommendation: parsed.data.recommendation,
      severity: parsed.data.severity,
      // Passed as a JSON string, not a parsed object/array - node-postgres
      // serializes a plain JS array using Postgres array-literal syntax
      // ("{...}") for a jsonb column instead of JSON text, which Postgres
      // then rejects. `promptInput` is already valid JSON text (see
      // formatSignals), so no parse/reparse round trip is needed here.
      signalsSnapshot: promptInput,
      generatedAt: new Date(),
      generatedBy: params.userId
    }
    return await insertMaintenanceReportFactory({ db: deps.db })(report)
  }

/** The model is instructed to return bare JSON, but strips a markdown fence if it adds one anyway. */
function tryParseJson(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(stripped)
  } catch {
    return null
  }
}
