import { BadRequestError } from '@/modules/shared/errors'
import type {
  AssetClassLevel,
  AssetClassRecord
} from '@/modules/facilities/helpers/types'
import {
  assetClassHasChildrenFactory,
  assetClassIsInUseFactory,
  getAssetClassByIdFactory
} from '@/modules/facilities/repositories/facilities'
import type { Knex } from 'knex'

const levelParent: Record<AssetClassLevel, AssetClassLevel | null> = {
  group: null,
  family: 'group',
  type: 'family'
}

const segmentPattern = /^[A-Z]{3}$/

export function assertClassName(name: string): string {
  const normalized = name.trim()
  if (!normalized || normalized.length > 120) {
    throw new BadRequestError('Asset class name must contain 1 to 120 characters')
  }
  return normalized
}

/** Validates that each node has exactly one parent at the preceding level. */
export function validateAssetClassPathFactory(deps: { db: Knex }) {
  return async (params: {
    facilityId: string
    parentId?: string | null
    level: AssetClassLevel
    code: string
  }): Promise<AssetClassRecord | null> => {
    if (!segmentPattern.test(params.code)) {
      throw new BadRequestError(
        'Each classification level code must be 3 uppercase letters'
      )
    }

    const requiredParentLevel = levelParent[params.level]
    if (!requiredParentLevel) {
      if (params.parentId)
        throw new BadRequestError('A group cannot have a parent class')
      return null
    }
    if (!params.parentId) {
      throw new BadRequestError(
        `A ${params.level} class requires a ${requiredParentLevel} parent`
      )
    }

    const parent = await getAssetClassByIdFactory(deps)({ id: params.parentId })
    if (!parent || parent.facilityId !== params.facilityId) {
      throw new BadRequestError('Parent class does not belong to this facility')
    }
    if (parent.level !== requiredParentLevel) {
      throw new BadRequestError(
        `A ${params.level} class must have a ${requiredParentLevel} parent`
      )
    }
    return parent
  }
}

export function assertAssignableAssetClassFactory(deps: { db: Knex }) {
  return async (params: {
    id: string
    facilityId: string
  }): Promise<AssetClassRecord> => {
    const assetClass = await getAssetClassByIdFactory(deps)({ id: params.id })
    if (!assetClass || assetClass.facilityId !== params.facilityId) {
      throw new BadRequestError('Asset class does not belong to this facility')
    }
    if (assetClass.level !== 'type') {
      throw new BadRequestError('Assets must be assigned to a type-level class')
    }
    return assetClass
  }
}

export function assertAssetClassCanBeDeletedFactory(deps: { db: Knex }) {
  return async (params: { id: string }): Promise<void> => {
    const [hasChildren, isInUse] = await Promise.all([
      assetClassHasChildrenFactory(deps)(params),
      assetClassIsInUseFactory(deps)(params)
    ])
    if (hasChildren || isInUse) {
      throw new BadRequestError(
        'Asset classes with children or assigned assets cannot be deleted'
      )
    }
  }
}
