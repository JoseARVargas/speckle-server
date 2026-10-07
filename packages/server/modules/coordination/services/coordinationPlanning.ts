import type { Knex } from 'knex'
import { CoordDeliverables, StreamAcl } from '@/modules/core/dbSchema'
import { BadRequestError } from '@/modules/shared/errors'
import type {
  CoordDeliverableRecord,
  DeliverableImportRow,
  DeliverableInput,
  NamingField,
  NamingFieldsInput
} from '@/modules/coordination/helpers/planningTypes'
import {
  NamingFields,
  PLANNING_LIMITS,
  buildContainerName,
  deliverableImportRowSchema,
  deliverableInputSchema,
  namingFieldsInputSchema
} from '@/modules/coordination/helpers/planningTypes'
import {
  countDeliverablesFactory,
  existingContainerNamesFactory,
  findProjectDeliverablesFactory,
  findProjectMilestonesFactory,
  findProjectRequirementsFactory,
  insertDeliverablesFactory,
  listNamingCodesFactory,
  listUsedCodesFactory,
  maxDeliverableNumberFactory,
  listProjectDependenciesFactory,
  replaceDeliverableDependenciesFactory,
  replaceDeliverableRequirementsFactory,
  replaceNamingCodesFactory,
  updateDeliverableFactory
} from '@/modules/coordination/repositories/planning'
import {
  assertModelInProjectFactory,
  isUniqueViolation,
  newCoordId,
  parseOrBadRequest
} from '@/modules/coordination/services/coordination'

/**
 * Information delivery planning (ISO 19650 MIDP/TIDP). See
 * officio-bim-coordination/.ai/plans/2026-10-06-planejamento-iso19650.md.
 * The MIDP is one table of deliverables; a TIDP is a filter by originator.
 */

export const FIELD_LABELS: Record<NamingField, string> = {
  project: 'projeto',
  originator: 'originador',
  volume: 'volume/zona',
  level: 'nível',
  type: 'tipo',
  role: 'papel'
}

type CodeMap = Record<NamingField, Set<string>>

const loadCodeMapFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string }): Promise<CodeMap> => {
    const map = Object.fromEntries(
      NamingFields.map((f) => [f, new Set<string>()])
    ) as CodeMap
    for (const row of await listNamingCodesFactory(deps)(p))
      map[row.field].add(row.code)
    return map
  }

/** First naming code of the input that isn't in the project's lists, if any. */
const invalidCode = (codes: CodeMap, input: Record<NamingField, string>) => {
  for (const field of NamingFields) {
    if (!codes[field].size) {
      return `Cadastre os códigos de ${FIELD_LABELS[field]} na Nomenclatura`
    }
    if (!codes[field].has(input[field])) {
      return `Código de ${FIELD_LABELS[field]} "${input[field]}" não está na lista do projeto`
    }
  }
  return null
}

const codesOf = (input: Record<NamingField, string>) =>
  Object.fromEntries(NamingFields.map((f) => [f, input[f]])) as Record<
    NamingField,
    string
  >

// ---- naming lists -------------------------------------------------------------

export const setNamingCodesFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; input: unknown }) => {
    const input: NamingFieldsInput = parseOrBadRequest(
      namingFieldsInputSchema,
      p.input,
      'Nomenclatura'
    )
    // A code still used by a deliverable can't disappear from its list
    for (const field of NamingFields) {
      const kept = new Set(input[field].map((c) => c.code))
      const used = await listUsedCodesFactory(deps)({ projectId: p.projectId, field })
      const removed = used.filter((code) => !kept.has(code))
      if (removed.length) {
        throw new BadRequestError(
          `O código de ${FIELD_LABELS[field]} "${removed[0]}" é usado por entregáveis`
        )
      }
    }
    await replaceNamingCodesFactory(deps)({
      projectId: p.projectId,
      rows: NamingFields.flatMap((field) =>
        input[field].map((c, position) => ({
          field,
          code: c.code,
          description: c.description,
          position
        }))
      )
    })
    return listNamingCodesFactory(deps)({ projectId: p.projectId })
  }

// ---- references -----------------------------------------------------------------

/**
 * True when following the dependency edges from any of "from" reaches
 * "target" - i.e. making target depend on "from" would close a cycle.
 */
export const reachesTarget = (
  edges: Map<string, string[]>,
  from: string[],
  target: string
) => {
  const seen = new Set<string>()
  const stack = [...from]
  while (stack.length) {
    const node = stack.pop()!
    if (node === target) return true
    if (seen.has(node)) continue
    seen.add(node)
    stack.push(...(edges.get(node) ?? []))
  }
  return false
}

const edgeMap = (rows: { deliverableId: string; dependsOnId: string }[]) => {
  const edges = new Map<string, string[]>()
  for (const r of rows)
    edges.set(r.deliverableId, [...(edges.get(r.deliverableId) ?? []), r.dependsOnId])
  return edges
}

const assertReferencesFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { projectId: string; input: DeliverableInput; selfId?: string }) => {
    const { input, projectId } = p
    const message = invalidCode(await loadCodeMapFactory(deps)({ projectId }), input)
    if (message) throw new BadRequestError(message)
    if (input.milestoneId) {
      const [milestone] = await findProjectMilestonesFactory(deps)({
        projectId,
        ids: [input.milestoneId]
      })
      if (!milestone) throw new BadRequestError('Marco não pertence a este projeto')
    }
    const requirementIds = [...new Set(input.requirementIds)]
    if (requirementIds.length) {
      const found = await findProjectRequirementsFactory(deps)({
        projectId,
        ids: requirementIds
      })
      if (found.length !== requirementIds.length) {
        throw new BadRequestError('Requisito não pertence a este projeto')
      }
    }
    if (input.responsibleUserId) {
      // A01: only a collaborator of this project can be made responsible
      const member = await deps
        .db(StreamAcl.name)
        .where({ resourceId: projectId, userId: input.responsibleUserId })
        .first()
      if (!member) {
        throw new BadRequestError('O responsável precisa ser colaborador do projeto')
      }
    }
    if (input.modelId) {
      await assertModelInProjectFactory(deps)({ projectId, modelId: input.modelId })
      // one deliverable per model: the CDE flow and its status follow it
      const other = await deps
        .db(CoordDeliverables.name)
        .where({ projectId, modelId: input.modelId })
        .whereNot({ id: p.selfId ?? '' })
        .first()
      if (other) {
        throw new BadRequestError(
          `Este modelo já é do entregável ${other.containerName}`
        )
      }
    }
    const dependsOnIds = [...new Set(input.dependsOnIds)]
    if (p.selfId && dependsOnIds.includes(p.selfId)) {
      throw new BadRequestError('Um entregável não pode depender de si mesmo')
    }
    if (dependsOnIds.length) {
      const found = await findProjectDeliverablesFactory(deps)({
        projectId,
        ids: dependsOnIds
      })
      if (found.length !== dependsOnIds.length) {
        throw new BadRequestError('Dependência não pertence a este projeto')
      }
      // A06: only an existing deliverable can be part of a cycle
      if (p.selfId) {
        const edges = edgeMap(await listProjectDependenciesFactory(deps)({ projectId }))
        edges.delete(p.selfId)
        if (reachesTarget(edges, dependsOnIds, p.selfId)) {
          throw new BadRequestError(
            'Essa dependência cria um ciclo: um dos entregáveis já depende deste'
          )
        }
      }
    }
    return { requirementIds, dependsOnIds }
  }

const assertCapacityFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; adding: number }) => {
    const count = await countDeliverablesFactory(deps)({
      projectId: p.projectId,
      filter: {}
    })
    if (count + p.adding > PLANNING_LIMITS.maxDeliverablesPerProject) {
      throw new BadRequestError(
        `Limite de ${PLANNING_LIMITS.maxDeliverablesPerProject} entregáveis por projeto`
      )
    }
  }

const duplicateMessage = (containerName: string) =>
  `Já existe um entregável com o código ${containerName}`

// ---- create / update ------------------------------------------------------------

export const createDeliverableFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { projectId: string; userId: string; input: unknown }) => {
    const input = parseOrBadRequest(deliverableInputSchema, p.input, 'Entregável')
    const { requirementIds, dependsOnIds } = await assertReferencesFactory(deps)({
      projectId: p.projectId,
      input
    })
    await assertCapacityFactory(deps)({ projectId: p.projectId, adding: 1 })
    const codes = codesOf(input)

    // Two writers can take the same next number: UNIQUE(containerName) catches
    // it and we retry with a fresh number (an explicit number is never changed).
    for (let attempt = 0; ; attempt++) {
      const number =
        input.number ??
        (await maxDeliverableNumberFactory(deps)({ projectId: p.projectId, codes })) + 1
      const containerName = buildContainerName(codes, number)
      try {
        return await deps.db.transaction(async (trx) => {
          const [row] = await insertDeliverablesFactory({ db: trx })([
            {
              id: newCoordId(),
              projectId: p.projectId,
              containerName,
              title: input.title,
              kind: input.kind,
              ...codes,
              number,
              milestoneId: input.milestoneId ?? null,
              responsibleUserId: input.responsibleUserId ?? null,
              modelId: input.modelId ?? null,
              dueDate: input.dueDate ?? null,
              status: input.status,
              notes: input.notes,
              createdBy: p.userId,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          ])
          await replaceDeliverableRequirementsFactory({ db: trx })({
            deliverableId: row.id,
            requirementIds
          })
          await replaceDeliverableDependenciesFactory({ db: trx })({
            deliverableId: row.id,
            dependsOnIds
          })
          return row
        })
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
        if (input.number || attempt + 1 >= PLANNING_LIMITS.numberRetries) {
          throw new BadRequestError(duplicateMessage(containerName))
        }
      }
    }
  }

export const updateDeliverableServiceFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { current: CoordDeliverableRecord; input: unknown }) => {
    const input = parseOrBadRequest(deliverableInputSchema, p.input, 'Entregável')
    const projectId = p.current.projectId
    const { requirementIds, dependsOnIds } = await assertReferencesFactory(deps)({
      projectId,
      input,
      selfId: p.current.id
    })
    const codes = codesOf(input)
    const sameCodes = NamingFields.every((f) => codes[f] === p.current[f])

    for (let attempt = 0; ; attempt++) {
      // keep the number while the codes don't change; a new series gets the next one
      const number =
        input.number ??
        (sameCodes
          ? p.current.number
          : (await maxDeliverableNumberFactory(deps)({ projectId, codes })) + 1)
      const containerName = buildContainerName(codes, number)
      try {
        return await deps.db.transaction(async (trx) => {
          const row = await updateDeliverableFactory({ db: trx })({
            id: p.current.id,
            update: {
              containerName,
              title: input.title,
              kind: input.kind,
              ...codes,
              number,
              milestoneId: input.milestoneId ?? null,
              responsibleUserId: input.responsibleUserId ?? null,
              modelId: input.modelId ?? null,
              dueDate: input.dueDate ?? null,
              status: input.status,
              notes: input.notes
            }
          })
          await replaceDeliverableRequirementsFactory({ db: trx })({
            deliverableId: p.current.id,
            requirementIds
          })
          await replaceDeliverableDependenciesFactory({ db: trx })({
            deliverableId: p.current.id,
            dependsOnIds
          })
          return row
        })
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
        const retryable = !input.number && !sameCodes
        if (!retryable || attempt + 1 >= PLANNING_LIMITS.numberRetries) {
          throw new BadRequestError(duplicateMessage(containerName))
        }
      }
    }
  }

// ---- import ---------------------------------------------------------------------

export type ImportError = { row: number; message: string }

const MAX_REPORTED_ERRORS = 200

/**
 * Imports CSV rows already mapped by the app. All or nothing (A06): any
 * invalid row means nothing is written, and every problem is reported with
 * its row number (1 = first data row) so the user can fix the spreadsheet.
 */
export const importDeliverablesFactory =
  (deps: { db: Knex }) =>
  async (p: {
    projectId: string
    userId: string
    rows: unknown
  }): Promise<{ imported: number; errors: ImportError[] }> => {
    if (!Array.isArray(p.rows) || !p.rows.length) {
      throw new BadRequestError('Nenhuma linha para importar')
    }
    if (p.rows.length > PLANNING_LIMITS.maxImportRows) {
      throw new BadRequestError(
        `Limite de ${PLANNING_LIMITS.maxImportRows} linhas por importação`
      )
    }
    await assertCapacityFactory(deps)({ projectId: p.projectId, adding: p.rows.length })

    const errors: ImportError[] = []
    const fail = (row: number, message: string) => {
      errors.push({ row, message })
    }

    // 1. shape of each row
    const parsed: { row: number; data: DeliverableImportRow }[] = []
    p.rows.forEach((raw, i) => {
      const res = deliverableImportRowSchema.safeParse(raw)
      if (res.success) {
        parsed.push({ row: i + 1, data: res.data })
        return
      }
      const issue = res.error.issues[0]
      const where = issue.path.length ? `${issue.path.join('.')}: ` : ''
      fail(i + 1, `${where}${issue.message}`)
    })

    // 2. references, resolved in one query each
    const codes = await loadCodeMapFactory(deps)({ projectId: p.projectId })
    const milestoneNames = [
      ...new Set(parsed.map((r) => r.data.milestone).filter((m): m is string => !!m))
    ]
    const milestones = new Map(
      (
        await findProjectMilestonesFactory(deps)({
          projectId: p.projectId,
          names: milestoneNames
        })
      ).map((m) => [m.name, m.id])
    )
    const requirementCodes = [
      ...new Set(parsed.flatMap((r) => r.data.requirementCodes))
    ]
    const requirements = new Map(
      (
        await findProjectRequirementsFactory(deps)({
          projectId: p.projectId,
          codes: requirementCodes
        })
      ).map((r) => [r.code, r.id])
    )

    // 3. numbers and container names (in the batch and against the database)
    const nextNumber = new Map<string, number>()
    const seen = new Map<string, number>()
    const records: {
      row: number
      record: CoordDeliverableRecord
      links: string[]
      dependsOn: string[]
      dependsOnIds: string[]
    }[] = []
    for (const { row, data } of parsed) {
      const codeError = invalidCode(codes, data)
      if (codeError) {
        fail(row, codeError)
        continue
      }
      if (data.milestone && !milestones.has(data.milestone)) {
        fail(row, `Marco "${data.milestone}" não existe no projeto`)
        continue
      }
      const missing = data.requirementCodes.find((c) => !requirements.has(c))
      if (missing) {
        fail(row, `Requisito "${missing}" não existe no projeto`)
        continue
      }
      const rowCodes = codesOf(data)
      const series = NamingFields.map((f) => rowCodes[f]).join('-')
      // each series counts from the highest number in the database or the batch
      const highest =
        nextNumber.get(series) ??
        (await maxDeliverableNumberFactory(deps)({
          projectId: p.projectId,
          codes: rowCodes
        }))
      const number = data.number ?? highest + 1
      nextNumber.set(series, Math.max(highest, number))
      const containerName = buildContainerName(rowCodes, number)
      const firstRow = seen.get(containerName)
      if (firstRow) {
        fail(row, `Código ${containerName} repetido (linha ${firstRow})`)
        continue
      }
      seen.set(containerName, row)
      records.push({
        row,
        record: {
          id: newCoordId(),
          projectId: p.projectId,
          containerName,
          title: data.title,
          kind: data.kind,
          ...rowCodes,
          number,
          milestoneId: data.milestone ? milestones.get(data.milestone) ?? null : null,
          responsibleUserId: null,
          modelId: null,
          dueDate: data.dueDate ?? null,
          status: data.status,
          notes: data.notes,
          createdBy: p.userId,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        links: [...new Set(data.requirementCodes)].map((c) => requirements.get(c)!),
        dependsOn: [...new Set(data.dependsOn)],
        dependsOnIds: []
      })
    }
    const existing = new Set(
      await existingContainerNamesFactory(deps)({
        projectId: p.projectId,
        names: records.map((r) => r.record.containerName)
      })
    )
    for (const r of records) {
      if (existing.has(r.record.containerName)) {
        fail(r.row, duplicateMessage(r.record.containerName))
      }
    }

    // 4. dependencies: codes of rows in this file or of deliverables already saved
    const inBatch = new Map(records.map((r) => [r.record.containerName, r.record.id]))
    const wanted = [...new Set(records.flatMap((r) => r.dependsOn))].filter(
      (name) => !inBatch.has(name)
    )
    const inDatabase = new Map(
      (wanted.length
        ? await findProjectDeliverablesFactory(deps)({
            projectId: p.projectId,
            names: wanted
          })
        : []
      ).map((d) => [d.containerName, d.id])
    )
    for (const r of records) {
      for (const name of r.dependsOn) {
        const id = inBatch.get(name) ?? inDatabase.get(name)
        if (!id) {
          fail(r.row, `Dependência "${name}" não existe no projeto nem no arquivo`)
        } else if (id === r.record.id) {
          fail(r.row, `O entregável ${name} não pode depender de si mesmo`)
        } else {
          r.dependsOnIds.push(id)
        }
      }
    }
    // saved deliverables never depend on new ones: a cycle can only be in the file
    const batchEdges = new Map(records.map((r) => [r.record.id, r.dependsOnIds]))
    for (const r of records) {
      const others = new Map(batchEdges)
      others.delete(r.record.id)
      if (reachesTarget(others, r.dependsOnIds, r.record.id)) {
        fail(r.row, `As dependências de ${r.record.containerName} formam um ciclo`)
      }
    }

    if (errors.length) {
      errors.sort((a, b) => a.row - b.row)
      return { imported: 0, errors: errors.slice(0, MAX_REPORTED_ERRORS) }
    }

    try {
      await deps.db.transaction(async (trx) => {
        const chunk = 500
        for (let i = 0; i < records.length; i += chunk) {
          await insertDeliverablesFactory({ db: trx })(
            records.slice(i, i + chunk).map((r) => r.record)
          )
        }
        for (const r of records) {
          if (r.links.length) {
            await replaceDeliverableRequirementsFactory({ db: trx })({
              deliverableId: r.record.id,
              requirementIds: r.links
            })
          }
          if (r.dependsOnIds.length) {
            await replaceDeliverableDependenciesFactory({ db: trx })({
              deliverableId: r.record.id,
              dependsOnIds: r.dependsOnIds
            })
          }
        }
      })
    } catch (err) {
      // someone created one of these codes meanwhile: nothing was written
      if (isUniqueViolation(err)) {
        throw new BadRequestError(
          'Outro usuário criou entregáveis com os mesmos códigos; importe de novo'
        )
      }
      throw err
    }
    return { imported: records.length, errors: [] }
  }
