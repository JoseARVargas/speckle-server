import type { Knex } from 'knex'
import { getObjectChildrenStreamFactory } from '@/modules/core/repositories/objects'
import { getCommitFactory } from '@/modules/core/repositories/commits'
import { FileUploads } from '@/modules/core/dbSchema'
import { BlobStorage } from '@/modules/blobstorage/repositories'

/**
 * MinIO object key of the original IFC a version was imported from, or null
 * when the version didn't come from an IFC upload (e.g. a connector). The
 * upload id is the blob id (see fileuploads/services/management.ts).
 */
export const resolveIfcObjectKeyFactory =
  (deps: { projectDb: Knex }) =>
  async (params: { projectId: string; versionId: string }): Promise<string | null> => {
    const upload = await deps
      .projectDb(FileUploads.name)
      .select<{ id: string; fileType: string; fileName: string }[]>([
        FileUploads.col.id,
        FileUploads.col.fileType,
        FileUploads.col.fileName
      ])
      .where(FileUploads.col.streamId, params.projectId)
      .andWhere(FileUploads.col.convertedCommitId, params.versionId)
      .orderBy(FileUploads.col.convertedLastUpdate, 'desc')
      .first()
    if (!upload) return null
    const extension = (upload.fileType || upload.fileName.split('.').pop() || '')
      .replace(/^\./, '')
      .toLowerCase()
    if (extension !== 'ifc') return null
    const blob = await deps
      .projectDb(BlobStorage.name)
      .select<{ objectKey: string | null }[]>([BlobStorage.col.objectKey])
      .where(BlobStorage.col.id, upload.id)
      .andWhere(BlobStorage.col.streamId, params.projectId)
      .first()
    return blob?.objectKey ?? null
  }

/**
 * The one place that knows how a Speckle version is laid out (root object +
 * closure of children). Speckle's 2026.9 data model drops the root object /
 * content hash for new-format versions - when that lands, a second
 * implementation of this reader replaces only this file.
 */

export type VersionElement = {
  /** applicationId (Revit UniqueId / IFC GlobalId); null = unkeyed */
  elementKey: string | null
  speckleObjectId: string
  data: Record<string, unknown>
}

const hasDisplayValue = (data: Record<string, unknown>) => {
  const dv = data.displayValue ?? data['@displayValue']
  if (Array.isArray(dv)) return dv.length > 0
  return !!dv && typeof dv === 'object'
}

/**
 * An "element" is a geometry-carrying object that isn't itself a geometry
 * primitive: walls, columns, pipes... but not their meshes, nor the
 * collections/layers grouping them.
 */
export const isElement = (data: Record<string, unknown>) => {
  const type = typeof data.speckle_type === 'string' ? data.speckle_type : ''
  if (type.startsWith('Objects.Geometry.')) return false
  return hasDisplayValue(data)
}

export const readVersionElementsFactory = (deps: { projectDb: Knex }) =>
  async function* (params: {
    projectId: string
    versionId: string
  }): AsyncGenerator<VersionElement> {
    const version = await getCommitFactory({ db: deps.projectDb })(params.versionId, {
      streamId: params.projectId
    })
    if (!version) throw new Error(`Version ${params.versionId} not found`)

    const stream = await getObjectChildrenStreamFactory({ db: deps.projectDb })({
      streamId: params.projectId,
      objectId: version.referencedObject
    })
    for await (const row of stream) {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(row.dataText) as Record<string, unknown>
      } catch {
        continue
      }
      if (!isElement(data)) continue
      const appId = data.applicationId
      yield {
        elementKey: typeof appId === 'string' && appId.trim() ? appId : null,
        speckleObjectId: row.id,
        data
      }
    }
  }
