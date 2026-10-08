import { db } from '@/db/knex'
import { Users } from '@/modules/core/dbSchema'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageCoordination } from '@/modules/coordination/helpers/access'
import type { CoordDocumentRevisionRecord } from '@/modules/coordination/helpers/cdeTypes'
import { transitionInputSchema } from '@/modules/coordination/helpers/cdeTypes'
import type { CoordDeliverableRecord } from '@/modules/coordination/helpers/planningTypes'
import { getDeliverableByIdFactory } from '@/modules/coordination/repositories/planning'
import { getDocumentRevisionByIdFactory } from '@/modules/coordination/repositories/documents'
import { auditFactory } from '@/modules/coordination/services/coordination'
import { transitionDocumentRevisionFactory } from '@/modules/coordination/services/coordinationCde'
import type { DocumentRevisionCde } from '@/modules/coordination/services/coordinationDocuments'
import {
  addDocumentRevisionFactory,
  getDocumentCdeFactory,
  removeDocumentRevisionFactory
} from '@/modules/coordination/services/coordinationDocuments'

/**
 * Document deliverables API. Reads are nested under Project.coordination
 * (core already checked read access); every write resolves the projectId from
 * the stored record and goes through assertCanManageCoordination (A01).
 */

const audit = auditFactory({ db })

const requireUser = (ctx: GraphQLContext) => {
  if (!ctx.userId) throw new ForbiddenError('No userId provided')
  return ctx.userId
}

type RevisionView = CoordDocumentRevisionRecord & {
  current: DocumentRevisionCde['current']
  history: DocumentRevisionCde['history']
}

const toView = (cde: DocumentRevisionCde): RevisionView => ({
  ...cde.revision,
  // bigint comes back as a string from pg
  fileSize: Number(cde.revision.fileSize),
  current: cde.current,
  history: cde.history
})

async function loadManagedRevision(ctx: GraphQLContext, revisionId: string) {
  const revision = await getDocumentRevisionByIdFactory({ db })({ id: revisionId })
  if (!revision) throw new NotFoundError('Revisão não encontrada')
  await assertCanManageCoordination(ctx, revision.projectId)
  return revision
}

export default {
  CoordDeliverable: {
    async documentRevisions(parent: CoordDeliverableRecord) {
      return (
        await getDocumentCdeFactory({ db })({
          projectId: parent.projectId,
          deliverableId: parent.id
        })
      ).map(toView)
    }
  },

  CoordDocumentRevision: {
    viewable(parent: RevisionView) {
      return parent.contentType === 'application/pdf'
    },
    async createdByName(parent: RevisionView) {
      if (!parent.createdBy) return null
      const user = await db(Users.name)
        .where(Users.col.id, parent.createdBy)
        .first<{ name: string } | undefined>(Users.col.name)
      return user?.name ?? null
    }
  },

  CoordinationMutations: {
    async addDocumentRevision(
      _parent: unknown,
      args: { deliverableId: string; blobId: string },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const deliverable = await getDeliverableByIdFactory({ db })({
        id: args.deliverableId
      })
      if (!deliverable) throw new NotFoundError('Entregável não encontrado')
      await assertCanManageCoordination(ctx, deliverable.projectId)
      const projectDb = await getProjectDbClient({ projectId: deliverable.projectId })
      const revision = await addDocumentRevisionFactory({ db, projectDb })({
        deliverable,
        blobId: args.blobId,
        userId
      })
      await audit({
        projectId: deliverable.projectId,
        actorId: userId,
        action: 'document_revision.added',
        entityType: 'document_revision',
        entityId: revision.id,
        data: {
          deliverableId: deliverable.id,
          fileName: revision.fileName,
          sha256: revision.sha256
        }
      })
      const [view] = (
        await getDocumentCdeFactory({ db })({
          projectId: deliverable.projectId,
          deliverableId: deliverable.id
        })
      ).filter((r) => r.revision.id === revision.id)
      return toView(view)
    },

    async transitionDocumentRevision(
      _parent: unknown,
      args: { revisionId: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const revision = await loadManagedRevision(ctx, args.revisionId)
      const input = transitionInputSchema.safeParse(args.input)
      if (!input.success)
        throw new BadRequestError('Dados da mudança de estado inválidos')
      return transitionDocumentRevisionFactory({ db })({
        projectId: revision.projectId,
        deliverableId: revision.deliverableId,
        revisionId: revision.id,
        userId,
        input: input.data
      })
    },

    async deleteDocumentRevision(
      _parent: unknown,
      args: { revisionId: string },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const revision = await loadManagedRevision(ctx, args.revisionId)
      const projectDb = await getProjectDbClient({ projectId: revision.projectId })
      await removeDocumentRevisionFactory({ db, projectDb })({ revision, userId })
      await audit({
        projectId: revision.projectId,
        actorId: userId,
        action: 'document_revision.deleted',
        entityType: 'document_revision',
        entityId: revision.id,
        data: { deliverableId: revision.deliverableId, fileName: revision.fileName }
      })
      return true
    }
  }
}
