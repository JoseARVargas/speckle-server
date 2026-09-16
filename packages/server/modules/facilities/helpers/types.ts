import type { Nullable } from '@speckle/shared'

export type AssetTypeNature = 'fixed' | 'movable'

export type FacilityRecord = {
  id: string
  projectId: string
  name: string
  tagSourceProperty: string
  createdAt: Date
  updatedAt: Date
}

export type FloorRecord = {
  id: string
  projectId: string
  facilityId: string
  name: string
  elevationZ: Nullable<number>
  createdAt: Date
  updatedAt: Date
}

export type SpaceRecord = {
  id: string
  projectId: string
  facilityId: string
  floorId: Nullable<string>
  name: string
  elevationZ: Nullable<number>
  speckleObjectId: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type AssetTypeRecord = {
  id: string
  name: string
  category: Nullable<string>
  manufacturer: Nullable<string>
  modelNumber: Nullable<string>
  nature: Nullable<AssetTypeNature>
  description: Nullable<string>
  expectedLifeYears: Nullable<number>
  extendedAttributes: Record<string, unknown>
  createdBy: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type AssetSystemRecord = {
  id: string
  projectId: string
  facilityId: string
  name: string
  description: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type AssetRecord = {
  id: string
  projectId: string
  facilityId: string
  tagNumber: string
  name: Nullable<string>
  assetTypeId: Nullable<string>
  spaceId: Nullable<string>
  currentObjectId: Nullable<string>
  currentVersionId: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type AssetSystemMemberRecord = {
  assetId: string
  systemId: string
}
