import type {
  DigitalTwinAssetSuitabilityStatus,
  FileUploadRecord,
  FileUploadRecordMetadata,
  FileUploadRecordV2
} from '@/modules/fileuploads/helpers/types'
import { FileUploadConvertedStatus } from '@/modules/fileuploads/helpers/types'
import type { GetProjectUploads } from '@/modules/fileuploads/domain/operations'
import type { FileImportResultPayload } from '@speckle/shared/workers/fileimport'

export type DigitalTwinAssetStatus = 'queued' | 'converting' | 'completed' | 'error'

export type DigitalTwinAsset = {
  id: string
  projectId: string
  modelId: string | null
  modelName: string | null
  userId: string
  fileName: string
  fileType: string
  fileSize: number | null
  source: 'speckle'
  status: DigitalTwinAssetStatus
  versionId: string | null
  uploadDate: Date
  convertedLastUpdate: Date
  convertedMessage: string | null
  metadata: FileUploadRecordMetadata | null
  performanceData: {
    durationSeconds: number
    downloadDurationSeconds: number
    parseDurationSeconds: number
  } | null
  warnings: string[]
  /**
   * ISO 19650-inspired information management fields - none of these affect
   * conversion, they're editable classification metadata for the asset.
   */
  discipline: string | null
  suitabilityStatus: DigitalTwinAssetSuitabilityStatus | null
  revision: string | null
}

export type DigitalTwinAssetGraphQLReturn = DigitalTwinAsset

type BuildDigitalTwinAssetParams = {
  upload: FileUploadRecord | FileUploadRecordV2
  jobResult?: FileImportResultPayload
}

const mapConvertedStatus = (
  convertedStatus: number | FileUploadConvertedStatus
): DigitalTwinAssetStatus => {
  switch (convertedStatus) {
    case FileUploadConvertedStatus.Queued:
      return 'queued'
    case FileUploadConvertedStatus.Converting:
      return 'converting'
    case FileUploadConvertedStatus.Completed:
      return 'completed'
    case FileUploadConvertedStatus.Error:
      return 'error'
    default:
      return 'queued'
  }
}

export const buildDigitalTwinAsset = ({
  upload,
  jobResult
}: BuildDigitalTwinAssetParams): DigitalTwinAsset => {
  const projectId = 'projectId' in upload ? upload.projectId : upload.streamId

  const versionId =
    jobResult?.status === 'success'
      ? jobResult.result.versionId
      : upload.convertedCommitId ?? null

  // Only the (legacy-named) V1 record type declares branchName, but the
  // physical column is populated for V2 uploads too (saveUploadFileFactoryV2
  // writes the model's name into it for backwards compat) - same pattern as
  // the projectId fallback above.
  const modelName = 'branchName' in upload ? upload.branchName : null

  return {
    id: upload.id,
    projectId,
    modelId: upload.modelId,
    modelName,
    userId: upload.userId,
    fileName: upload.fileName,
    fileType: upload.fileType,
    fileSize: upload.fileSize,
    source: 'speckle',
    status: mapConvertedStatus(upload.convertedStatus),
    versionId,
    uploadDate: upload.uploadDate,
    convertedLastUpdate: upload.convertedLastUpdate,
    convertedMessage: upload.convertedMessage,
    metadata: upload.metadata ?? null,
    performanceData: upload.performanceData ?? null,
    warnings:
      jobResult?.status === 'success'
        ? jobResult.warnings ?? []
        : jobResult?.status === 'error'
        ? [jobResult.reason]
        : [],
    discipline: upload.discipline ?? null,
    suitabilityStatus: upload.suitabilityStatus ?? null,
    revision: upload.revision ?? null
  }
}

type ListDigitalTwinAssetsParams = {
  projectId: string
  limit?: number
  cursor?: string | null
}

export const listDigitalTwinAssetsFactory =
  (deps: { getProjectUploads: GetProjectUploads }) =>
  async (
    params: ListDigitalTwinAssetsParams
  ): Promise<{
    items: DigitalTwinAsset[]
    totalCount: number
    cursor: string | null
  }> => {
    const { items, totalCount, cursor } = await deps.getProjectUploads(params)

    return {
      items: items.map((upload) => buildDigitalTwinAsset({ upload })),
      totalCount,
      cursor
    }
  }
