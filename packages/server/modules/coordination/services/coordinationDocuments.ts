import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { BlobUploadStatus } from '@speckle/shared/blobs'
import { BadRequestError } from '@/modules/shared/errors'
import { getProjectObjectStorage } from '@/modules/multiregion/utils/blobStorageSelector'
import {
  deleteBlobFactory,
  getBlobMetadataFactory
} from '@/modules/blobstorage/repositories'
import {
  deleteObjectFactory,
  getObjectStreamFactory
} from '@/modules/blobstorage/repositories/blobs'
import { fullyDeleteBlobFactory } from '@/modules/blobstorage/services/management'
import type {
  CoordDocumentRevisionRecord,
  CoordVersionStateRecord
} from '@/modules/coordination/helpers/cdeTypes'
import { DOCUMENT_LIMITS } from '@/modules/coordination/helpers/cdeTypes'
import type { CoordDeliverableRecord } from '@/modules/coordination/helpers/planningTypes'
import {
  countDocumentRevisionsFactory,
  deleteDocumentRevisionFactory,
  findDocumentRevisionByHashFactory,
  insertDocumentRevisionFactory,
  listDocumentRevisionsFactory,
  listDocumentStatesFactory
} from '@/modules/coordination/repositories/documents'
import {
  getCdeConfigFactory,
  groupBySubject,
  recordDocumentRevisionCreatedFactory,
  syncDocumentDeliverableStatusFactory
} from '@/modules/coordination/services/coordinationCde'
import { newCoordId } from '@/modules/coordination/services/coordination'

/**
 * Document deliverables (drawings, documents, schedules): each uploaded file
 * is a revision with the same ISO 19650 CDE flow as a model version. The file
 * goes to Speckle's blob storage (no conversion); registering it here checks
 * it really is what it claims to be. Plan:
 * speckle-digitaltwin-console/.ai/plans/2026-10-08-documentos-entregaveis-coordenacao.md
 */

export const DOCUMENT_DELIVERABLE_KINDS = ['drawing', 'document', 'schedule', 'other']

export const isDocumentDeliverable = (d: Pick<CoordDeliverableRecord, 'kind'>) =>
  DOCUMENT_DELIVERABLE_KINDS.includes(d.kind)

// ---- file type detection (A05: from the bytes, never from the client) --------

type DetectedType = { extension: string; contentType: string }

const HEAD_BYTES = 64

const startsWith = (head: Buffer, signature: number[] | string) => {
  const bytes =
    typeof signature === 'string' ? Buffer.from(signature, 'latin1') : signature
  return head.length >= bytes.length && bytes.every((b, i) => head[i] === b)
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]

/**
 * Phase 1 formats: PDF (viewed in the app) plus DWG, DXF, XLSX and DOCX as
 * download-only attachments. The extension must match the content: a ".pdf"
 * that isn't a PDF is refused.
 */
export const detectDocumentType = (
  fileName: string,
  head: Buffer
): DetectedType | null => {
  const extension = (fileName.split('.').pop() ?? '').toLowerCase()
  switch (extension) {
    case 'pdf':
      // the PDF header may come after a few junk bytes (spec allows 1024)
      return head.includes(Buffer.from('%PDF-', 'latin1'))
        ? { extension, contentType: 'application/pdf' }
        : null
    case 'dwg':
      return startsWith(head, 'AC10')
        ? { extension, contentType: 'image/vnd.dwg' }
        : null
    case 'dxf': {
      if (startsWith(head, 'AutoCAD Binary DXF')) {
        return { extension, contentType: 'image/vnd.dxf' }
      }
      // ASCII DXF: group code 0 then SECTION (optionally after a 999 comment)
      const text = head.toString('latin1').replace(/^﻿/, '').trimStart()
      return /^(999\s*\r?\n[^\n]*\r?\n\s*)?0\s*\r?\nSECTION/.test(text)
        ? { extension, contentType: 'image/vnd.dxf' }
        : null
    }
    case 'xlsx':
      return startsWith(head, ZIP)
        ? {
            extension,
            contentType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        : null
    case 'docx':
      return startsWith(head, ZIP)
        ? {
            extension,
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          }
        : null
    default:
      return null
  }
}

/** Reads the stored file once: its first bytes and its SHA-256. */
const inspectStream = async (stream: Readable) => {
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let headLength = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    hash.update(buf)
    if (headLength < 1024) {
      chunks.push(buf)
      headLength += buf.length
    }
  }
  return {
    head: Buffer.concat(chunks).subarray(0, Math.max(HEAD_BYTES, 1024)),
    sha256: hash.digest('hex')
  }
}

// ---- revisions ----------------------------------------------------------------

const blobDeps = async (p: { projectId: string; projectDb: Knex }) => {
  const storage = await getProjectObjectStorage({ projectId: p.projectId })
  const getBlobMetadata = getBlobMetadataFactory({ db: p.projectDb })
  return {
    getBlobMetadata,
    getObjectStream: getObjectStreamFactory({ storage: storage.private }),
    fullyDeleteBlob: fullyDeleteBlobFactory({
      getBlobMetadata,
      deleteBlob: deleteBlobFactory({ db: p.projectDb }),
      deleteObject: deleteObjectFactory({ storage: storage.private })
    })
  }
}

/**
 * Registers an uploaded blob as the next revision of a document deliverable
 * and puts it in the first WIP state. A blob that fails a check is deleted,
 * so refused files don't linger in storage.
 */
export const addDocumentRevisionFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: {
    deliverable: CoordDeliverableRecord
    blobId: string
    userId: string
  }) => {
    const { deliverable } = p
    if (!isDocumentDeliverable(deliverable)) {
      throw new BadRequestError(
        'Entregável de modelo recebe versões pela aba Modelos, não arquivos'
      )
    }
    const blobs = await blobDeps({
      projectId: deliverable.projectId,
      projectDb: deps.projectDb
    })
    const meta = await blobs
      .getBlobMetadata({ streamId: deliverable.projectId, blobId: p.blobId })
      .catch(() => null)
    if (!meta) throw new BadRequestError('Arquivo não encontrado neste projeto')
    if (meta.uploadStatus !== BlobUploadStatus.Completed || !meta.objectKey) {
      throw new BadRequestError('O envio do arquivo não terminou com sucesso')
    }

    const refuse = async (message: string): Promise<never> => {
      await blobs
        .fullyDeleteBlob({ streamId: deliverable.projectId, blobId: p.blobId })
        .catch(() => undefined)
      throw new BadRequestError(message)
    }

    if ((meta.fileSize ?? 0) > DOCUMENT_LIMITS.maxFileBytes) {
      return await refuse('Arquivo maior que o limite de 100 MB')
    }
    const count = await countDocumentRevisionsFactory(deps)({
      deliverableId: deliverable.id
    })
    if (count >= DOCUMENT_LIMITS.maxRevisionsPerDeliverable) {
      return await refuse(
        `O entregável já tem ${DOCUMENT_LIMITS.maxRevisionsPerDeliverable} revisões`
      )
    }

    const { head, sha256 } = await inspectStream(
      await blobs.getObjectStream({ objectKey: meta.objectKey })
    )
    const type = detectDocumentType(meta.fileName, head)
    if (!type) {
      return await refuse(
        'Formato não aceito ou arquivo diferente da extensão (aceitos: PDF, DWG, DXF, XLSX, DOCX)'
      )
    }
    const duplicate = await findDocumentRevisionByHashFactory(deps)({
      deliverableId: deliverable.id,
      sha256
    })
    if (duplicate) {
      return await refuse(
        `Este arquivo já foi enviado neste entregável (${duplicate.fileName})`
      )
    }

    const config = await getCdeConfigFactory(deps)({ projectId: deliverable.projectId })
    const revision = await deps.db.transaction(async (trx) => {
      const row = await insertDocumentRevisionFactory({ db: trx })({
        id: newCoordId(),
        projectId: deliverable.projectId,
        deliverableId: deliverable.id,
        blobId: p.blobId,
        fileName: meta.fileName,
        fileSize: meta.fileSize ?? 0,
        contentType: type.contentType,
        extension: type.extension,
        sha256,
        createdBy: p.userId,
        createdAt: new Date()
      })
      await recordDocumentRevisionCreatedFactory({ db: trx })({
        projectId: deliverable.projectId,
        deliverableId: deliverable.id,
        documentRevisionId: row.id,
        config
      })
      return row
    })
    await syncDocumentDeliverableStatusFactory(deps)({
      projectId: deliverable.projectId,
      deliverableId: deliverable.id,
      actorId: p.userId
    })
    return revision
  }

export type DocumentRevisionCde = {
  revision: CoordDocumentRevisionRecord
  current: CoordVersionStateRecord | null
  history: CoordVersionStateRecord[]
}

/** Revisions of a deliverable with their CDE state, newest first. */
export const getDocumentCdeFactory =
  (deps: { db: Knex }) =>
  async (p: {
    projectId: string
    deliverableId: string
  }): Promise<DocumentRevisionCde[]> => {
    const [revisions, rows] = await Promise.all([
      listDocumentRevisionsFactory(deps)(p),
      listDocumentStatesFactory(deps)(p)
    ])
    const bySubject = new Map(groupBySubject(rows).map((g) => [g.subjectId, g]))
    return revisions.map((revision) => {
      const group = bySubject.get(revision.id)
      return {
        revision,
        current: group?.current ?? null,
        history: group?.history ?? []
      }
    })
  }

/**
 * Only a revision that never left WIP can be removed (with its file): once
 * shared, it is part of the record (ISO 19650 audit trail).
 */
export const removeDocumentRevisionFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { revision: CoordDocumentRevisionRecord; userId: string }) => {
    const rows = (
      await listDocumentStatesFactory(deps)({
        projectId: p.revision.projectId,
        deliverableId: p.revision.deliverableId
      })
    ).filter((r) => r.documentRevisionId === p.revision.id)
    if (rows.some((r) => r.stage !== 'wip')) {
      throw new BadRequestError(
        'Só uma revisão que nunca saiu do WIP pode ser excluída; as outras ficam no histórico'
      )
    }
    await deleteDocumentRevisionFactory(deps)({ id: p.revision.id })
    const blobs = await blobDeps({
      projectId: p.revision.projectId,
      projectDb: deps.projectDb
    })
    await blobs
      .fullyDeleteBlob({ streamId: p.revision.projectId, blobId: p.revision.blobId })
      .catch(() => undefined)
    await syncDocumentDeliverableStatusFactory(deps)({
      projectId: p.revision.projectId,
      deliverableId: p.revision.deliverableId,
      actorId: p.userId
    })
  }

/**
 * Removes the files of a deliverable that was just deleted (its revision rows
 * went by cascade). The caller lists the blobs before deleting, then calls this.
 */
export const deleteDocumentFilesFactory =
  (deps: { projectDb: Knex }) =>
  async (p: { projectId: string; blobIds: string[] }) => {
    if (!p.blobIds.length) return
    const blobs = await blobDeps({ projectId: p.projectId, projectDb: deps.projectDb })
    for (const blobId of p.blobIds) {
      await blobs
        .fullyDeleteBlob({ streamId: p.projectId, blobId })
        .catch(() => undefined)
    }
  }
