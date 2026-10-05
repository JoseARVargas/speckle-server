import { z } from 'zod'
import { db } from '@/db/knex'
import { StreamAcl, Users } from '@/modules/core/dbSchema'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageCoordination } from '@/modules/coordination/helpers/access'
import type {
  ClashStatus,
  CoordClashRunRecord,
  CoordClashTestRecord
} from '@/modules/coordination/helpers/clashTypes'
import { CLASH_LIMITS, ClashStatuses } from '@/modules/coordination/helpers/clashTypes'
import {
  countClashesByStatusFactory,
  deleteClashTestFactory,
  getClashesByIdsFactory,
  getClashRunFactory,
  getClashTestByIdFactory,
  getClashTestFactory,
  listClashesFactory,
  listClashRunsFactory,
  listClashTestsFactory,
  updateClashesFactory
} from '@/modules/coordination/repositories/clash'
import {
  createClashTestFactory,
  enqueueClashRunFactory,
  updateClashTestServiceFactory
} from '@/modules/coordination/services/coordinationClash'
import { auditFactory } from '@/modules/coordination/services/coordination'
import { CoordRunLimitError } from '@/modules/coordination/services/coordinationRunner'

/**
 * Clash detection API. Reads are nested under Project.coordination (core
 * already checked read access); every write resolves the projectId from
 * the stored record and goes through assertCanManageCoordination (A01).
 */

type CoordParent = { projectId: string }

const audit = auditFactory({ db })

const requireUser = (ctx: GraphQLContext) => {
  if (!ctx.userId) throw new ForbiddenError('No userId provided')
  return ctx.userId
}

async function loadManagedTest(ctx: GraphQLContext, id: string) {
  const test = await getClashTestByIdFactory({ db })({ id })
  if (!test) throw new NotFoundError('Teste de clash não encontrado')
  await assertCanManageCoordination(ctx, test.projectId)
  return test
}

const statusSchema = z.enum(ClashStatuses)
const idsSchema = z
  .array(z.string().min(1).max(10))
  .min(1)
  .max(CLASH_LIMITS.maxClashesPage)
const commentSchema = z.string().trim().max(2000).nullable().optional()

/** All ids must exist and belong to one project the caller can manage. */
async function loadManagedClashes(ctx: GraphQLContext, rawIds: unknown) {
  const parsed = idsSchema.safeParse(rawIds)
  if (!parsed.success) throw new BadRequestError('Lista de clashes inválida')
  const clashes = await getClashesByIdsFactory({ db })({ ids: parsed.data })
  if (clashes.length !== new Set(parsed.data).size) {
    throw new NotFoundError('Clash não encontrado')
  }
  const projects = new Set(clashes.map((c) => c.projectId))
  if (projects.size !== 1) throw new BadRequestError('Clashes de projetos diferentes')
  await assertCanManageCoordination(ctx, clashes[0].projectId)
  return { ids: parsed.data, projectId: clashes[0].projectId }
}

const runWithUserMessage = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof CoordRunLimitError) throw new BadRequestError(err.message)
    throw err
  }
}

export default {
  ProjectCoordination: {
    clashAssignees(parent: CoordParent) {
      // project members only see their own project's team (core gated the read)
      return db(StreamAcl.name)
        .join(Users.name, Users.col.id, StreamAcl.col.userId)
        .where(StreamAcl.col.resourceId, parent.projectId)
        .select<{ id: string; name: string }[]>([Users.col.id, Users.col.name])
        .orderBy(Users.col.name)
    },
    clashTests(parent: CoordParent) {
      return listClashTestsFactory({ db })({ projectId: parent.projectId })
    },
    async clashTest(parent: CoordParent, args: { id: string }) {
      return (
        (await getClashTestFactory({ db })({
          projectId: parent.projectId,
          id: args.id
        })) ?? null
      )
    },
    async clashRun(parent: CoordParent, args: { id: string }) {
      return (
        (await getClashRunFactory({ db })({
          projectId: parent.projectId,
          id: args.id
        })) ?? null
      )
    }
  },

  CoordClashTest: {
    runs(parent: CoordClashTestRecord, args: { limit?: number | null }) {
      return listClashRunsFactory({ db })({
        projectId: parent.projectId,
        testId: parent.id,
        limit: Math.min(Math.max(args.limit ?? 10, 1), 50)
      })
    },
    async lastRun(parent: CoordClashTestRecord) {
      const [run] = await listClashRunsFactory({ db })({
        projectId: parent.projectId,
        testId: parent.id,
        limit: 1
      })
      return run ?? null
    }
  },

  CoordClashRun: {
    async statusCounts(parent: CoordClashRunRecord) {
      if (parent.status !== 'succeeded') return []
      const rows = await countClashesByStatusFactory({ db })({
        projectId: parent.projectId,
        runId: parent.id
      })
      return rows.map((r) => ({ status: r.status, count: Number(r.count) }))
    },
    clashes(
      parent: CoordClashRunRecord,
      args: {
        statuses?: string[] | null
        keyA?: string | null
        limit?: number | null
        offset?: number | null
      }
    ) {
      if (parent.status !== 'succeeded') return []
      const statuses = (args.statuses ?? []).filter(
        (s): s is ClashStatus => statusSchema.safeParse(s).success
      )
      return listClashesFactory({ db })({
        projectId: parent.projectId,
        runId: parent.id,
        statuses,
        keyA: args.keyA,
        limit: Math.min(Math.max(args.limit ?? 500, 1), CLASH_LIMITS.maxClashesPage),
        offset: Math.max(args.offset ?? 0, 0)
      })
    }
  },

  CoordinationMutations: {
    async createClashTest(
      _parent: unknown,
      args: { projectId: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertCanManageCoordination(ctx, args.projectId)
      const projectDb = await getProjectDbClient({ projectId: args.projectId })
      const test = await createClashTestFactory({ db, projectDb })({
        projectId: args.projectId,
        userId,
        input: args.input
      })
      await audit({
        projectId: test.projectId,
        actorId: userId,
        action: 'clash_test.created',
        entityType: 'clash_test',
        entityId: test.id,
        data: { name: test.name }
      })
      return test
    },

    async updateClashTest(
      _parent: unknown,
      args: { id: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const current = await loadManagedTest(ctx, args.id)
      const projectDb = await getProjectDbClient({ projectId: current.projectId })
      const test = await updateClashTestServiceFactory({ db, projectDb })({
        test: current,
        input: args.input
      })
      await audit({
        projectId: test.projectId,
        actorId: userId,
        action: 'clash_test.updated',
        entityType: 'clash_test',
        entityId: test.id
      })
      return test
    },

    async deleteClashTest(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
      const userId = requireUser(ctx)
      const test = await loadManagedTest(ctx, args.id)
      await deleteClashTestFactory({ db })({ id: test.id })
      await audit({
        projectId: test.projectId,
        actorId: userId,
        action: 'clash_test.deleted',
        entityType: 'clash_test',
        entityId: test.id,
        data: { name: test.name }
      })
      return true
    },

    async runClashTest(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
      const userId = requireUser(ctx)
      const test = await loadManagedTest(ctx, args.id)
      const projectDb = await getProjectDbClient({ projectId: test.projectId })
      const run = await runWithUserMessage(() =>
        enqueueClashRunFactory({ db, projectDb })({
          test,
          trigger: 'manual',
          createdBy: userId
        })
      )
      await audit({
        projectId: test.projectId,
        actorId: userId,
        action: 'clash_run.queued',
        entityType: 'clash_run',
        entityId: run.id,
        data: { testId: test.id }
      })
      return run
    },

    async setClashStatus(
      _parent: unknown,
      args: { ids: string[]; status: string; comment?: string | null },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const status = statusSchema.safeParse(args.status)
      if (!status.success) throw new BadRequestError('Status de clash inválido')
      const comment = commentSchema.safeParse(args.comment)
      if (!comment.success) throw new BadRequestError('Comentário inválido')
      const { ids, projectId } = await loadManagedClashes(ctx, args.ids)
      const updated = await updateClashesFactory({ db })({
        ids,
        update: {
          status: status.data,
          ...(comment.data !== undefined ? { comment: comment.data } : {})
        }
      })
      await audit({
        projectId,
        actorId: userId,
        action: 'clash.status_changed',
        entityType: 'clash',
        entityId: ids[0],
        data: { count: ids.length, status: status.data }
      })
      return updated
    },

    async assignClashes(
      _parent: unknown,
      args: { ids: string[]; assignee?: string | null },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const assignee = z
        .string()
        .min(1)
        .max(10)
        .nullable()
        .safeParse(args.assignee ?? null)
      if (!assignee.success) throw new BadRequestError('Responsável inválido')
      const { ids, projectId } = await loadManagedClashes(ctx, args.ids)
      if (assignee.data) {
        // A01: only a collaborator of this project can be made responsible
        const member = await db(StreamAcl.name)
          .where({ resourceId: projectId, userId: assignee.data })
          .first()
        if (!member)
          throw new BadRequestError('O responsável precisa ser colaborador do projeto')
      }
      const updated = await updateClashesFactory({ db })({
        ids,
        update: { assignee: assignee.data }
      })
      await audit({
        projectId,
        actorId: userId,
        action: 'clash.assigned',
        entityType: 'clash',
        entityId: ids[0],
        data: { count: ids.length, assignee: assignee.data }
      })
      return updated
    }
  }
}
