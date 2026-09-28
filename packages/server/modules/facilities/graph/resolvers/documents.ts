import { db } from '@/db/knex'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { getProjectObjectStorage } from '@/modules/multiregion/utils/blobStorageSelector'
import { NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageFacility } from '@/modules/facilities/graph/resolvers/facilities'
import { ensureFacilityFactory, newId } from '@/modules/facilities/services/facilities'
import {
  getAssetByIdFactory,
  getSpaceByIdFactory
} from '@/modules/facilities/repositories/facilities'
import {
  listFacilityDocumentsFactory,
  countFacilityDocumentsFactory,
  getFacilityDocumentByIdFactory,
  insertFacilityDocumentFactory,
  updateFacilityDocumentFactory,
  deleteFacilityDocumentFactory
} from '@/modules/facilities/repositories/documents'
import {
  getBlobMetadataFactory,
  deleteBlobFactory
} from '@/modules/blobstorage/repositories'
import { deleteObjectFactory } from '@/modules/blobstorage/repositories/blobs'
import { fullyDeleteBlobFactory } from '@/modules/blobstorage/services/management'
import type {
  DocumentCategory,
  DocumentStatus
} from '@/modules/facilities/helpers/types'

const documentMutations = {
  async create(
    _parent: unknown,
    args: {
      input: {
        projectId: string
        title: string
        category?: DocumentCategory | null
        description?: string | null
        assetId?: string | null
        spaceId?: string | null
        blobId: string
        fileName: string
        fileSize?: number | null
        status?: DocumentStatus | null
        revision?: string | null
      }
    },
    ctx: GraphQLContext
  ) {
    const {
      projectId,
      title,
      category,
      description,
      assetId,
      spaceId,
      blobId,
      fileName,
      fileSize,
      status,
      revision
    } = args.input
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    const facility = await ensureFacilityFactory({ db: projectDb })({ projectId })
    return await insertFacilityDocumentFactory({ db: projectDb })({
      id: newId(),
      projectId,
      facilityId: facility.id,
      assetId: assetId ?? null,
      spaceId: spaceId ?? null,
      title,
      category: category ?? null,
      description: description ?? null,
      blobId,
      fileName,
      fileSize: fileSize ?? null,
      status: status ?? 'work_in_progress',
      revision: revision ?? 'P01',
      uploadedBy: ctx.userId ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  },

  async update(
    _parent: unknown,
    args: {
      input: {
        id: string
        title?: string | null
        category?: DocumentCategory | null
        description?: string | null
        assetId?: string | null
        spaceId?: string | null
        status?: DocumentStatus | null
        revision?: string | null
      }
    },
    ctx: GraphQLContext
  ) {
    const { id, title, category, description, assetId, spaceId, status, revision } =
      args.input
    const document = await getFacilityDocumentByIdFactory({ db })({ id })
    if (!document) throw new NotFoundError('Document not found')
    await assertCanManageFacility(ctx, document.projectId)
    const projectDb = await getProjectDbClient({ projectId: document.projectId })
    return await updateFacilityDocumentFactory({ db: projectDb })({
      id,
      update: {
        ...(title !== undefined && title !== null ? { title } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(assetId !== undefined ? { assetId } : {}),
        ...(spaceId !== undefined ? { spaceId } : {}),
        ...(status !== undefined && status !== null ? { status } : {}),
        ...(revision !== undefined ? { revision } : {})
      }
    })
  },

  async delete(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const document = await getFacilityDocumentByIdFactory({ db })({ id: args.id })
    if (!document) throw new NotFoundError('Document not found')
    await assertCanManageFacility(ctx, document.projectId)
    const projectDb = await getProjectDbClient({ projectId: document.projectId })

    // Clean up the underlying blob too, not just our metadata row - the
    // same operation the blob storage REST API's own DELETE route uses.
    const projectStorage = await getProjectObjectStorage({
      projectId: document.projectId
    })
    const fullyDeleteBlob = fullyDeleteBlobFactory({
      getBlobMetadata: getBlobMetadataFactory({ db: projectDb }),
      deleteBlob: deleteBlobFactory({ db: projectDb }),
      deleteObject: deleteObjectFactory({ storage: projectStorage.private })
    })
    try {
      await fullyDeleteBlob({ streamId: document.projectId, blobId: document.blobId })
    } catch {
      // The metadata row is still the source of truth for the UI - if the
      // blob is already gone (or storage is briefly unavailable), don't
      // block removing the document over it.
    }

    await deleteFacilityDocumentFactory({ db: projectDb })({ id: args.id })
    return true
  }
}

export default {
  Facility: {
    async documents(
      parent: { id: string; projectId: string },
      args: {
        input?: {
          limit?: number | null
          cursor?: string | null
          category?: DocumentCategory | null
          assetId?: string | null
          spaceId?: string | null
        } | null
      }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      const params = {
        facilityId: parent.id,
        limit: args.input?.limit ?? 50,
        cursor: args.input?.cursor,
        category: args.input?.category,
        assetId: args.input?.assetId,
        spaceId: args.input?.spaceId
      }
      const [items, totalCount] = await Promise.all([
        listFacilityDocumentsFactory({ db: projectDb })(params),
        countFacilityDocumentsFactory({ db: projectDb })(params)
      ])
      return {
        items,
        totalCount,
        cursor: items.length ? items[items.length - 1].id : null
      }
    }
  },

  FacilityDocument: {
    async asset(parent: { assetId: string | null; projectId: string }) {
      if (!parent.assetId) return null
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await getAssetByIdFactory({ db: projectDb })({ id: parent.assetId })
    },
    async space(parent: { spaceId: string | null; projectId: string }) {
      if (!parent.spaceId) return null
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await getSpaceByIdFactory({ db: projectDb })({ id: parent.spaceId })
    }
  },

  Mutation: {
    documentMutations: () => ({})
  },
  DocumentMutations: {
    ...documentMutations
  }
}
