import type { Nullable } from '@speckle/shared'
import { z } from 'zod'
import {
  COORD_LIMITS,
  coordConditionSchema
} from '@/modules/coordination/helpers/coordinationTypes'

/**
 * Clash detection between discipline models (IFC). See
 * officio-bim-coordination/.ai/plans/2026-10-05-clash.md.
 */

// ---- limits (A06; sized for a 1 vCPU / 4 GB VPS) ----------------------------

export const CLASH_LIMITS = {
  maxElementsPerGroup: 20_000,
  maxRawPairs: 50_000,
  maxQueuedRunsPerProject: 5,
  maxManualRunsPerProjectPerHour: 20,
  /** a run waiting for memory/worker longer than this fails */
  maxWaitMinutes: 90,
  keptRunsPerTest: 10,
  maxClashesPage: 500
} as const

// ---- test definition --------------------------------------------------------

export const ClashTypes = ['hard', 'clearance'] as const
export type ClashType = (typeof ClashTypes)[number]

const groupSchema = z
  .object({
    modelId: z.string().trim().min(1).max(10),
    /** optional Search Set whose conditions are prepended when a run is queued */
    searchSetId: z.string().trim().min(1).max(10).nullish(),
    where: z
      .array(coordConditionSchema)
      .max(COORD_LIMITS.maxConditionsPerList)
      .default([])
  })
  .strict()

export type ClashGroup = z.infer<typeof groupSchema>

const ignoreSchema = z
  .object({
    sameElement: z.boolean().default(true),
    hosted: z.boolean().default(true),
    connected: z.boolean().default(true),
    sameSystem: z.boolean().default(false),
    /** elements matching this condition are planned openings/passages: their clashes are ignored */
    plannedOpening: coordConditionSchema.nullable().default(null)
  })
  .strict()

export type ClashIgnore = z.infer<typeof ignoreSchema>

export const clashTestInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(ClashTypes),
    toleranceMm: z.number().min(0).max(1000).default(5),
    clearanceMm: z.number().positive().max(5000).nullable().default(null),
    groupA: groupSchema,
    /** null = A x A (clashes inside the same group) */
    groupB: groupSchema.nullable().default(null),
    ignore: ignoreSchema.default({}),
    autoRun: z.boolean().default(false)
  })
  .strict()
  .superRefine((test, ctx) => {
    if (test.type === 'clearance' && !test.clearanceMm) {
      ctx.addIssue({
        code: 'custom',
        message: 'um teste de folga precisa da folga mínima em mm'
      })
    }
  })

export type ClashTestInput = z.infer<typeof clashTestInputSchema>

/** What a run freezes from its test at enqueue time. */
export type ClashRunSettings = Pick<
  ClashTestInput,
  'type' | 'toleranceMm' | 'clearanceMm' | 'groupA' | 'groupB' | 'ignore'
>

// ---- records ------------------------------------------------------------------

export type ClashRunStatus =
  | 'queued'
  | 'geometry'
  | 'geometry_running'
  | 'geometry_done'
  | 'processing'
  | 'succeeded'
  | 'failed'

export const ClashStatuses = [
  'new',
  'active',
  'reviewed',
  'approved',
  'resolved'
] as const
export type ClashStatus = (typeof ClashStatuses)[number]

export type ClashRelation = 'hosted' | 'connected' | 'same_system'

export type CoordClashTestRecord = {
  id: string
  projectId: string
  name: string
  type: ClashType
  toleranceMm: number
  clearanceMm: Nullable<number>
  groupA: ClashGroup
  groupB: Nullable<ClashGroup>
  ignore: ClashIgnore
  autoRun: boolean
  createdBy: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type CoordClashRunRecord = {
  id: string
  projectId: string
  testId: string
  modelIdA: string
  versionIdA: string
  objectKeyA: string
  modelIdB: string
  versionIdB: string
  objectKeyB: string
  trigger: 'manual' | 'version_created'
  status: ClashRunStatus
  attempt: number
  createdBy: Nullable<string>
  settings: ClashRunSettings
  queuedAt: Date
  startedAt: Nullable<Date>
  finishedAt: Nullable<Date>
  error: Nullable<string>
  countA: number
  countB: number
  rawCount: number
  ignoredCount: number
  clashCount: number
  geometrySeconds: Nullable<number>
  peakRssMb: Nullable<number>
}

export type CoordClashRunElementRecord = {
  runId: string
  side: 'a' | 'b'
  elementKey: string
  speckleObjectId: Nullable<string>
  plannedOpening: boolean
}

export type CoordClashRawRecord = {
  runId: string
  keyA: string
  keyB: string
  distanceMm: number
  point: Nullable<number[]>
  clashType: string
  relation: Nullable<ClashRelation>
}

export type CoordClashRecord = {
  id: string
  projectId: string
  runId: string
  testId: string
  fingerprint: string
  keyA: string
  keyB: string
  speckleObjectIdA: Nullable<string>
  speckleObjectIdB: Nullable<string>
  distanceMm: number
  point: Nullable<number[]>
  clashType: string
  status: ClashStatus
  assignee: Nullable<string>
  comment: Nullable<string>
  createdAt: Date
  updatedAt: Date
}
