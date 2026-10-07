import type { Nullable } from '@speckle/shared'
import { z } from 'zod'
import {
  COORD_LIMITS,
  coordConditionSchema
} from '@/modules/coordination/helpers/coordinationTypes'

/**
 * Phase 2a: property index per model version and Search Sets. See
 * officio-bim-coordination/.ai/plans/2026-10-06-fase2-search-sets-bsdd-ids.md.
 */

// ---- limits (A06) -----------------------------------------------------------

export const PROPERTY_LIMITS = {
  /** paths kept in the index (most frequent first) */
  maxIndexedPaths: 2_000,
  /** distinct paths tracked while scanning, before trimming */
  maxTrackedPaths: 20_000,
  samplesPerPath: 5,
  maxSampleLength: 80,
  maxSearchSetsPerProject: 200,
  previewSample: 50,
  /** object ids returned for highlighting the matches in the viewer */
  previewObjectIds: 10_000
} as const

/** Element fields that carry no information for selecting elements. */
export const UNINDEXED_ROOT_KEYS = new Set(['id', 'totalChildrenCount', 'speckle_type'])

// ---- search sets ------------------------------------------------------------

export const searchSetWhereSchema = z
  .array(coordConditionSchema)
  .min(1, 'informe ao menos uma condição')
  .max(COORD_LIMITS.maxConditionsPerList)

export const searchSetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform((v) => (v ? v : null)),
    modelId: z.string().trim().min(1).max(10).nullish(),
    where: searchSetWhereSchema
  })
  .strict()
export type SearchSetInput = z.infer<typeof searchSetInputSchema>

// ---- records ----------------------------------------------------------------

export type IndexedPath = { path: string; count: number; samples: string[] }
export type IfcTypeCount = { type: string; count: number }

export type CoordPropertyIndexRecord = {
  versionId: string
  projectId: string
  modelId: string
  elementCount: number
  truncated: boolean
  paths: IndexedPath[]
  ifcTypes: IfcTypeCount[]
  createdAt: Date
}

export type CoordSearchSetRecord = {
  id: string
  projectId: string
  name: string
  description: Nullable<string>
  modelId: Nullable<string>
  where: z.infer<typeof searchSetWhereSchema>
  createdBy: Nullable<string>
  createdAt: Date
  updatedAt: Date
}
