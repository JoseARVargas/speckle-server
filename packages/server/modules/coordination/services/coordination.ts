import type { Knex } from 'knex'
import cryptoRandomString from 'crypto-random-string'
import { z } from 'zod'
import { BadRequestError, NotFoundError } from '@/modules/shared/errors'
import {
  getBranchLatestCommitsFactory,
  getProjectModelByIdFactory
} from '@/modules/core/repositories/branches'
import {
  getCommitBranchFactory,
  getCommitFactory
} from '@/modules/core/repositories/commits'
import type {
  CoordCheckRunRecord,
  CoordIdsEditableField,
  CoordRequirementRecord,
  CoordRuleInput,
  CoordRuleRecord,
  CoordRuleSetRecord,
  CoordRuleSetVersionRecord
} from '@/modules/coordination/helpers/coordinationTypes'
import {
  COORD_LIMITS,
  coordIdsRuleMetadataSchema,
  coordRuleInputSchema,
  coordRuleSetImportSchema,
  isIdsRuleDefinition
} from '@/modules/coordination/helpers/coordinationTypes'
import {
  countRulesFactory,
  countUserTriggeredRunsSinceFactory,
  getDraftVersionFactory,
  getLatestPublishedVersionFactory,
  getLatestSucceededRunFactory,
  getMaxVersionNumberFactory,
  getMilestoneByNameFactory,
  getMilestoneFactory,
  getRequirementByCodeFactory,
  getRequirementFactory,
  getRequirementsByIdsFactory,
  insertAuditEventFactory,
  insertMilestoneFactory,
  insertRequirementFactory,
  insertRequirementSourceFactory,
  insertRuleSetFactory,
  insertRuleSetVersionFactory,
  insertRulesFactory,
  listCheckRunsFactory,
  listRequirementSourcesFactory,
  listRequirementStatsFactory,
  listRequirementsFactory,
  listRuleSetsByMilestoneFactory,
  listRulesFactory,
  listRunModelIdsFactory,
  updateRuleFactory,
  updateRuleSetVersionFactory
} from '@/modules/coordination/repositories/coordination'
import {
  CoordRunLimitError,
  enqueueCheckRunFactory
} from '@/modules/coordination/services/coordinationRunner'
import { resolveIfcObjectKeyFactory } from '@/modules/coordination/services/coordinationReader'

export const newCoordId = () => cryptoRandomString({ length: 10 })

const IMPORTED_SOURCE_TITLE = 'Importado'

// ---- validation helpers ----------------------------------------------------------

/** Turns a zod failure into a client-facing BadRequestError with the first issue. */
export const parseOrBadRequest = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
  what: string
): T => {
  const res = schema.safeParse(input)
  if (res.success) return res.data
  const issue = res.error.issues[0]
  const where = issue.path.length ? ` (${issue.path.join('.')})` : ''
  throw new BadRequestError(`${what} inválido${where}: ${issue.message}`)
}

export const isUniqueViolation = (err: unknown) =>
  !!err && typeof err === 'object' && (err as { code?: string }).code === '23505'

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

export const requirementSourceInputSchema = z.object({
  kind: z.enum(['OIR', 'AIR', 'PIR', 'EIR']),
  title: z.string().trim().min(1).max(200),
  document: optionalText(200),
  revision: optionalText(50),
  clause: optionalText(100),
  parentId: optionalText(10)
})

export const milestoneInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dueDate: z
    .date()
    .nullish()
    .transform((v) => v ?? null),
  discipline: optionalText(100)
})

export const requirementInputSchema = z.object({
  sourceId: z.string().min(1).max(10),
  milestoneId: optionalText(10),
  code: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(300),
  discipline: optionalText(100),
  purpose: optionalText(300),
  targetPct: z.number().min(0).max(100).nullish()
})

export const ruleSetInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  milestoneId: optionalText(10),
  purpose: optionalText(300)
})

// ---- cross-reference checks (A01: ids from the client must be in the project) ---

export const assertMilestoneInProjectFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; milestoneId: string | null }) => {
    if (!p.milestoneId) return
    const milestone = await getMilestoneFactory(deps)({
      projectId: p.projectId,
      id: p.milestoneId
    })
    if (!milestone) throw new BadRequestError('Marco não pertence a este projeto')
  }

export const assertRequirementInProjectFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; requirementId: string | null | undefined }) => {
    if (!p.requirementId) return
    const req = await getRequirementFactory(deps)({
      projectId: p.projectId,
      id: p.requirementId
    })
    if (!req) throw new BadRequestError('Requisito não pertence a este projeto')
  }

/** The model must belong to the project (read from the project's database). */
export const assertModelInProjectFactory =
  (deps: { projectDb: Knex }) => async (p: { projectId: string; modelId: string }) => {
    const model = await getProjectModelByIdFactory({ db: deps.projectDb })({
      projectId: p.projectId,
      modelId: p.modelId
    })
    if (!model) throw new BadRequestError('Modelo não pertence a este projeto')
    return model
  }

/**
 * Resolves the version to check: the given one (which must be a version of
 * this model in this project) or the model's latest.
 */
export const resolveModelVersionFactory =
  (deps: { projectDb: Knex }) =>
  async (p: { projectId: string; modelId: string; versionId?: string | null }) => {
    await assertModelInProjectFactory(deps)(p)
    if (p.versionId) {
      const version = await getCommitFactory({ db: deps.projectDb })(p.versionId, {
        streamId: p.projectId
      })
      const branch = version
        ? await getCommitBranchFactory({ db: deps.projectDb })(p.versionId)
        : null
      if (!version || branch?.id !== p.modelId) {
        throw new BadRequestError('Versão não pertence a este modelo')
      }
      return version.id
    }
    const [latest] = await getBranchLatestCommitsFactory({ db: deps.projectDb })(
      [p.modelId],
      p.projectId
    )
    if (!latest) throw new BadRequestError('O modelo ainda não tem versões')
    return latest.id
  }

// ---- audit (A09) -------------------------------------------------------------------

export const auditFactory =
  (deps: { db: Knex }) =>
  async (p: {
    projectId: string
    actorId: string | null
    action: string
    entityType: string
    entityId: string
    data?: unknown
  }) =>
    await insertAuditEventFactory(deps)({
      id: newCoordId(),
      projectId: p.projectId,
      actorId: p.actorId,
      action: p.action,
      entityType: p.entityType,
      entityId: p.entityId,
      data: p.data ?? null,
      createdAt: new Date()
    })

// ---- drafts & rules ----------------------------------------------------------------

const toRuleRecord = (
  input: CoordRuleInput,
  base: {
    id: string
    projectId: string
    ruleSetVersionId: string
    requirementId: string | null
    position: number
  }
): CoordRuleRecord => ({
  id: base.id,
  projectId: base.projectId,
  ruleSetVersionId: base.ruleSetVersionId,
  code: input.code,
  name: input.name,
  requirementId: base.requirementId,
  severity: input.severity,
  weight: input.weight,
  definition: { where: input.where, check: input.check },
  position: base.position,
  createdAt: new Date(),
  updatedAt: new Date()
})

const copyRules = (rules: CoordRuleRecord[], ruleSetVersionId: string) =>
  rules.map((r) => ({
    ...r,
    id: newCoordId(),
    ruleSetVersionId,
    createdAt: new Date(),
    updatedAt: new Date()
  }))

/** Returns the editable draft, creating it from the latest published version. */
export const ensureDraftFactory =
  (deps: { db: Knex }) =>
  async (ruleSet: CoordRuleSetRecord): Promise<CoordRuleSetVersionRecord> => {
    const existing = await getDraftVersionFactory(deps)({ ruleSetId: ruleSet.id })
    if (existing) return existing
    const published = await getLatestPublishedVersionFactory(deps)({
      ruleSetId: ruleSet.id
    })
    const max = await getMaxVersionNumberFactory(deps)({ ruleSetId: ruleSet.id })
    const draft = await insertRuleSetVersionFactory(deps)({
      id: newCoordId(),
      projectId: ruleSet.projectId,
      ruleSetId: ruleSet.id,
      version: max + 1,
      status: 'draft',
      publishedAt: null,
      publishedBy: null,
      idsXml: published?.idsXml ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    if (published) {
      const rules = await listRulesFactory(deps)({ ruleSetVersionId: published.id })
      await insertRulesFactory(deps)(copyRules(rules, draft.id))
    }
    return draft
  }

/**
 * A rule id from the UI can point at the published version (when no draft
 * existed yet) - edits always land on the draft's copy, matched by code.
 */
export const resolveDraftRuleFactory =
  (deps: { db: Knex }) =>
  async (p: { rule: CoordRuleRecord; draft: CoordRuleSetVersionRecord }) => {
    if (p.rule.ruleSetVersionId === p.draft.id) return p.rule
    const draftRules = await listRulesFactory(deps)({ ruleSetVersionId: p.draft.id })
    const match = draftRules.find((r) => r.code === p.rule.code)
    if (!match) throw new NotFoundError('Regra não encontrada no rascunho')
    return match
  }

/**
 * IDS rules: only the metadata is editable (the IfcTester validation comes
 * from the IDS XML). Changed fields are recorded in definition.edited so a
 * re-import of the IDS keeps them.
 */
const updateIdsRuleMetadataFactory =
  (deps: { db: Knex }) =>
  async (p: {
    ruleSet: CoordRuleSetRecord
    existingRule: CoordRuleRecord | null
    input: unknown
  }) => {
    if (!p.existingRule) {
      throw new BadRequestError(
        'Um conjunto IDS não aceita regras novas: adicione a especificação no IDS e importe a nova versão'
      )
    }
    const input = parseOrBadRequest(
      coordIdsRuleMetadataSchema,
      p.input,
      'Regra IDS (só nome, severidade, peso e requisito são editáveis)'
    )
    await assertRequirementInProjectFactory(deps)({
      projectId: p.ruleSet.projectId,
      requirementId: input.requirementId
    })
    const draft = await ensureDraftFactory(deps)(p.ruleSet)
    const target = await resolveDraftRuleFactory(deps)({ rule: p.existingRule, draft })
    if (!isIdsRuleDefinition(target.definition)) {
      throw new BadRequestError('Regra IDS inválida')
    }
    const next = {
      name: input.name,
      severity: input.severity,
      weight: input.weight,
      requirementId: input.requirementId ?? null
    }
    const edited = new Set<CoordIdsEditableField>(target.definition.edited ?? [])
    for (const field of Object.keys(next) as CoordIdsEditableField[]) {
      if (next[field] !== target[field]) edited.add(field)
    }
    return await updateRuleFactory(deps)({
      id: target.id,
      update: {
        ...next,
        definition: { ...target.definition, edited: [...edited].sort() }
      }
    })
  }

export const upsertDraftRuleFactory =
  (deps: { db: Knex }) =>
  async (p: {
    ruleSet: CoordRuleSetRecord
    existingRule: CoordRuleRecord | null
    input: unknown
  }) => {
    if (p.ruleSet.format === 'ids') {
      return await updateIdsRuleMetadataFactory(deps)({
        ruleSet: p.ruleSet,
        existingRule: p.existingRule,
        input: p.input
      })
    }
    const input = parseOrBadRequest(coordRuleInputSchema, p.input, 'Regra')
    await assertRequirementInProjectFactory(deps)({
      projectId: p.ruleSet.projectId,
      requirementId: input.requirementId
    })
    const draft = await ensureDraftFactory(deps)(p.ruleSet)
    try {
      if (p.existingRule) {
        const target = await resolveDraftRuleFactory(deps)({
          rule: p.existingRule,
          draft
        })
        return await updateRuleFactory(deps)({
          id: target.id,
          update: {
            code: input.code,
            name: input.name,
            requirementId: input.requirementId ?? null,
            severity: input.severity,
            weight: input.weight,
            definition: { where: input.where, check: input.check }
          }
        })
      }
      const count = await countRulesFactory(deps)({ ruleSetVersionId: draft.id })
      if (count >= COORD_LIMITS.maxRulesPerVersion) {
        throw new BadRequestError(
          `Um conjunto aceita no máximo ${COORD_LIMITS.maxRulesPerVersion} regras`
        )
      }
      const [created] = await insertRulesFactory(deps)([
        toRuleRecord(input, {
          id: newCoordId(),
          projectId: p.ruleSet.projectId,
          ruleSetVersionId: draft.id,
          requirementId: input.requirementId ?? null,
          position: count
        })
      ])
      return created
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestError(`Já existe uma regra com o código ${input.code}`)
      }
      throw err
    }
  }

export const publishRuleSetFactory =
  (deps: { db: Knex }) =>
  async (p: { ruleSet: CoordRuleSetRecord; userId: string }) => {
    const draft = await getDraftVersionFactory(deps)({ ruleSetId: p.ruleSet.id })
    if (!draft) throw new BadRequestError('Não há rascunho para publicar')
    const count = await countRulesFactory(deps)({ ruleSetVersionId: draft.id })
    if (!count) throw new BadRequestError('O rascunho não tem regras')
    return await updateRuleSetVersionFactory(deps)({
      id: draft.id,
      update: { status: 'published', publishedAt: new Date(), publishedBy: p.userId }
    })
  }

// ---- import --------------------------------------------------------------------------

/** "EIR 4.2 — Pilares com classe de concreto" -> { code: "EIR 4.2", title: "Pilares..." } */
export const splitRequirementLabel = (label: string) => {
  const m = label.match(/^(.+?)\s+[—–-]\s+(.+)$/)
  return m
    ? { code: m[1].trim(), title: m[2].trim() }
    : { code: label.trim(), title: label.trim() }
}

/**
 * Requirement labels ("EIR 4.2 — Pilares ...") -> requirement ids, creating
 * unknown codes under an "Importado" EIR source. Keys are lowercased codes.
 */
export const resolveRequirementLabelsFactory =
  (deps: { db: Knex }) =>
  async (p: {
    projectId: string
    milestoneId: string | null
    labels: Array<string | null | undefined>
  }) => {
    const createdRequirements: string[] = []
    const requirementIds = new Map<string, string>()
    let importedSourceId: string | null = null
    for (const label of p.labels) {
      if (!label) continue
      const { code, title } = splitRequirementLabel(label)
      const key = code.toLowerCase()
      if (requirementIds.has(key)) continue
      const found = await getRequirementByCodeFactory(deps)({
        projectId: p.projectId,
        code
      })
      if (found) {
        requirementIds.set(key, found.id)
        continue
      }
      if (!importedSourceId) {
        const sources = await listRequirementSourcesFactory(deps)({
          projectId: p.projectId
        })
        importedSourceId =
          sources.find((s) => s.kind === 'EIR' && s.title === IMPORTED_SOURCE_TITLE)
            ?.id ??
          (
            await insertRequirementSourceFactory(deps)({
              id: newCoordId(),
              projectId: p.projectId,
              kind: 'EIR',
              title: IMPORTED_SOURCE_TITLE,
              document: null,
              revision: null,
              clause: null,
              parentId: null,
              createdAt: new Date(),
              updatedAt: new Date()
            })
          ).id
      }
      const created = await insertRequirementFactory(deps)({
        id: newCoordId(),
        projectId: p.projectId,
        sourceId: importedSourceId,
        milestoneId: p.milestoneId,
        code,
        title,
        discipline: null,
        purpose: null,
        targetPct: 95,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      requirementIds.set(key, created.id)
      createdRequirements.push(code)
    }
    return { requirementIds, createdRequirements }
  }

export const importRuleSetFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; document: unknown; userId: string }) => {
    if (JSON.stringify(p.document ?? null).length > COORD_LIMITS.maxImportBytes) {
      throw new BadRequestError('Arquivo de regras grande demais (limite de 1 MB)')
    }
    const doc = parseOrBadRequest(
      coordRuleSetImportSchema,
      p.document,
      'Arquivo de regras'
    )
    const codes = doc.rules.map((r) => r.code.toLowerCase())
    if (new Set(codes).size !== codes.length) {
      throw new BadRequestError('Há códigos de regra repetidos no arquivo')
    }

    let milestoneId: string | null = null
    if (doc.milestone) {
      const existing = await getMilestoneByNameFactory(deps)({
        projectId: p.projectId,
        name: doc.milestone
      })
      milestoneId =
        existing?.id ??
        (
          await insertMilestoneFactory(deps)({
            id: newCoordId(),
            projectId: p.projectId,
            name: doc.milestone,
            dueDate: null,
            discipline: null,
            createdAt: new Date(),
            updatedAt: new Date()
          })
        ).id
    }

    for (const rule of doc.rules) {
      if (rule.requirementId) {
        throw new BadRequestError(
          'Use "requirement" (código) no arquivo, não requirementId'
        )
      }
    }
    const { requirementIds, createdRequirements } =
      await resolveRequirementLabelsFactory(deps)({
        projectId: p.projectId,
        milestoneId,
        labels: doc.rules.map((r) => r.requirement ?? null)
      })

    const ruleSet = await insertRuleSetFactory(deps)({
      id: newCoordId(),
      projectId: p.projectId,
      name: doc.name,
      format: 'native',
      milestoneId,
      purpose: doc.purpose ?? null,
      createdBy: p.userId,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    const draft = await ensureDraftFactory(deps)(ruleSet)
    await insertRulesFactory(deps)(
      doc.rules.map((rule, position) =>
        toRuleRecord(rule, {
          id: newCoordId(),
          projectId: p.projectId,
          ruleSetVersionId: draft.id,
          requirementId: rule.requirement
            ? requirementIds.get(
                splitRequirementLabel(rule.requirement).code.toLowerCase()
              ) ?? null
            : null,
          position
        })
      )
    )
    return { ruleSet, createdRequirements }
  }

export const duplicateRuleSetFactory =
  (deps: { db: Knex }) =>
  async (p: { source: CoordRuleSetRecord; name: string; userId: string }) => {
    const from =
      (await getDraftVersionFactory(deps)({ ruleSetId: p.source.id })) ??
      (await getLatestPublishedVersionFactory(deps)({ ruleSetId: p.source.id }))
    const ruleSet = await insertRuleSetFactory(deps)({
      ...p.source,
      id: newCoordId(),
      name: p.name,
      // A copy of the generated set is an ordinary, hand-maintained set
      generatedFrom: null,
      createdBy: p.userId,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    const draft = await ensureDraftFactory(deps)(ruleSet)
    if (from) {
      const rules = await listRulesFactory(deps)({ ruleSetVersionId: from.id })
      await insertRulesFactory(deps)(copyRules(rules, draft.id))
      if (from.idsXml) {
        await updateRuleSetVersionFactory(deps)({
          id: draft.id,
          update: { idsXml: from.idsXml }
        })
      }
    }
    return ruleSet
  }

// ---- runs ------------------------------------------------------------------------------

/** Hourly cap on user-triggered runs per project (A06: each run reads a whole model). */
const assertRunQuotaFactory =
  (deps: { db: Knex }) => async (p: { projectId: string }) => {
    const since = new Date(Date.now() - 60 * 60 * 1000)
    const count = await countUserTriggeredRunsSinceFactory(deps)({
      projectId: p.projectId,
      since
    })
    if (count >= COORD_LIMITS.maxManualRunsPerProjectPerHour) {
      throw new BadRequestError(
        'Limite de verificações por hora atingido neste projeto; tente mais tarde'
      )
    }
  }

/**
 * Native rule sets run on the Speckle objects; IDS rule sets need the
 * version's original IFC, resolved now so the Python worker only reads it.
 */
const resolveRunSourceFactory =
  (deps: { projectDb: Knex }) =>
  async (p: { ruleSet: CoordRuleSetRecord; versionId: string }) => {
    if (p.ruleSet.format !== 'ids') {
      return { engine: 'native' as const, ifcObjectKey: null }
    }
    const ifcObjectKey = await resolveIfcObjectKeyFactory(deps)({
      projectId: p.ruleSet.projectId,
      versionId: p.versionId
    })
    if (!ifcObjectKey) {
      throw new BadRequestError(
        'Esta versão não veio de um arquivo IFC importado; a validação IDS exige o IFC original'
      )
    }
    return { engine: 'ids' as const, ifcObjectKey }
  }

const enqueueOrBadRequest = async (
  enqueue: () => ReturnType<ReturnType<typeof enqueueCheckRunFactory>>
) => {
  try {
    return (await enqueue()).run
  } catch (err) {
    if (err instanceof CoordRunLimitError) throw new BadRequestError(err.message)
    throw err
  }
}

export const runCheckFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: {
    ruleSet: CoordRuleSetRecord
    modelId: string
    versionId?: string | null
    userId: string
  }) => {
    const published = await getLatestPublishedVersionFactory(deps)({
      ruleSetId: p.ruleSet.id
    })
    if (!published) throw new BadRequestError('Publique o conjunto antes de executar')
    const versionId = await resolveModelVersionFactory(deps)({
      projectId: p.ruleSet.projectId,
      modelId: p.modelId,
      versionId: p.versionId
    })
    const source = await resolveRunSourceFactory(deps)({
      ruleSet: p.ruleSet,
      versionId
    })
    await assertRunQuotaFactory(deps)({ projectId: p.ruleSet.projectId })
    return await enqueueOrBadRequest(() =>
      enqueueCheckRunFactory(deps)({
        projectId: p.ruleSet.projectId,
        ruleSetId: p.ruleSet.id,
        ruleSetVersionId: published.id,
        modelId: p.modelId,
        versionId,
        trigger: 'manual',
        createdBy: p.userId,
        ...source
      })
    )
  }

export const previewDraftFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { ruleSet: CoordRuleSetRecord; modelId: string; userId: string }) => {
    const draft = await getDraftVersionFactory(deps)({ ruleSetId: p.ruleSet.id })
    if (!draft) throw new BadRequestError('Não há rascunho para pré-visualizar')
    const count = await countRulesFactory(deps)({ ruleSetVersionId: draft.id })
    if (!count) throw new BadRequestError('O rascunho não tem regras')
    const versionId = await resolveModelVersionFactory(deps)({
      projectId: p.ruleSet.projectId,
      modelId: p.modelId
    })
    const source = await resolveRunSourceFactory(deps)({
      ruleSet: p.ruleSet,
      versionId
    })
    await assertRunQuotaFactory(deps)({ projectId: p.ruleSet.projectId })
    return await enqueueOrBadRequest(() =>
      enqueueCheckRunFactory(deps)({
        projectId: p.ruleSet.projectId,
        ruleSetId: p.ruleSet.id,
        ruleSetVersionId: draft.id,
        modelId: p.modelId,
        versionId,
        trigger: 'preview',
        createdBy: p.userId,
        ...source
      })
    )
  }

// ---- compliance aggregation -------------------------------------------------------------

export type RequirementCompliance = {
  requirement: CoordRequirementRecord
  applicable: number
  passed: number
  adherence: number | null
}

/** Sums per-requirement stats across runs (a federated view over several models). */
export const getRequirementComplianceFactory =
  (deps: { db: Knex }) =>
  async (p: {
    projectId: string
    runIds: string[]
    extraRequirementIds?: string[]
  }): Promise<RequirementCompliance[]> => {
    const stats = await listRequirementStatsFactory(deps)({ runIds: p.runIds })
    const totals = new Map<string, { applicable: number; passed: number }>()
    for (const s of stats) {
      const t = totals.get(s.requirementId) ?? { applicable: 0, passed: 0 }
      t.applicable += s.applicableCount
      t.passed += s.passCount
      totals.set(s.requirementId, t)
    }
    for (const id of p.extraRequirementIds ?? []) {
      if (!totals.has(id)) totals.set(id, { applicable: 0, passed: 0 })
    }
    const requirements = await getRequirementsByIdsFactory(deps)({
      projectId: p.projectId,
      ids: [...totals.keys()]
    })
    return requirements
      .map((requirement) => {
        const t = totals.get(requirement.id)!
        return {
          requirement,
          applicable: t.applicable,
          passed: t.passed,
          adherence: t.applicable ? t.passed / t.applicable : null
        }
      })
      .sort((a, b) => a.requirement.code.localeCompare(b.requirement.code))
  }

const HISTORY_SIZE = 8

export const getMilestoneReportFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; milestoneId: string }) => {
    const milestone = await getMilestoneFactory(deps)({
      projectId: p.projectId,
      id: p.milestoneId
    })
    if (!milestone) return null

    const ruleSets = await listRuleSetsByMilestoneFactory(deps)(p)
    const latest: CoordCheckRunRecord[] = []
    const history: CoordCheckRunRecord[] = []
    for (const ruleSet of ruleSets) {
      const modelIds = await listRunModelIdsFactory(deps)({
        projectId: p.projectId,
        ruleSetId: ruleSet.id
      })
      for (const modelId of modelIds) {
        const run = await getLatestSucceededRunFactory(deps)({
          projectId: p.projectId,
          ruleSetId: ruleSet.id,
          modelId
        })
        if (!run) continue
        latest.push(run)
        const older = await listCheckRunsFactory(deps)({
          projectId: p.projectId,
          ruleSetId: ruleSet.id,
          modelId,
          status: 'succeeded',
          limit: HISTORY_SIZE + 1
        })
        history.push(...older.filter((r) => r.id !== run.id))
      }
    }

    const applicable = latest.reduce((sum, r) => sum + r.applicableCount, 0)
    const weighted = latest.reduce(
      (sum, r) => sum + (r.adherence ?? 0) * r.applicableCount,
      0
    )
    const milestoneRequirements = await listRequirementsFactory(deps)({
      projectId: p.projectId,
      milestoneId: p.milestoneId
    })
    return {
      milestone,
      runs: latest,
      adherence: applicable ? weighted / applicable : null,
      elements: latest.reduce((sum, r) => sum + r.elementCount, 0),
      unkeyed: latest.reduce((sum, r) => sum + r.unkeyedCount, 0),
      requirements: await getRequirementComplianceFactory(deps)({
        projectId: p.projectId,
        runIds: latest.map((r) => r.id),
        extraRequirementIds: milestoneRequirements.map((r) => r.id)
      }),
      history: history
        .sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime())
        .slice(0, HISTORY_SIZE)
    }
  }
