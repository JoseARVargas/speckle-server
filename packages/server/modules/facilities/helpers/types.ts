import type { Nullable } from '@speckle/shared'

export type AssetTypeNature = 'fixed' | 'movable'

export type FacilityRecord = {
  id: string
  projectId: string
  name: string
  tagSourceProperty: string
  energyTariffPerKwh: number
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
  /**
   * Soft classification base (e.g. "IfcAirTerminal", "IfcFurnishingElement")
   * - free text, not an enforced IFC schema.
   */
  ifcClass: Nullable<string>
  /**
   * Gates whether assets of this type get power/temperature simulation
   * controls (e.g. false for furniture/structural types). Null is treated
   * as true so existing types keep working unchanged.
   */
  isControllableDevice: Nullable<boolean>
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
  installDate: Nullable<Date>
  warrantyStartDate: Nullable<Date>
  serialNumber: Nullable<string>
  barCode: Nullable<string>
  extendedAttributes: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export type AssetSystemMemberRecord = {
  assetId: string
  systemId: string
}

export type DevicePowerState = 'on' | 'off'

export type DeviceStateRecord = {
  assetId: string
  projectId: string
  powerState: DevicePowerState
  setpoint: number
  currentTemperature: number
  ambientTemperature: number
  nominalPowerKw: number
  cumulativeKwh: number
  cumulativeCost: number
  updatedAt: Date
}

export type DeviceCommandType = 'power_on' | 'power_off' | 'set_temperature'

export type DeviceCommandRecord = {
  id: string
  assetId: string
  projectId: string
  commandType: DeviceCommandType
  value: Nullable<number>
  issuedBy: Nullable<string>
  issuedAt: Date
}

export type TelemetryReadingRecord = {
  id: string
  assetId: string
  projectId: string
  ts: Date
  temperature: number
  powerState: DevicePowerState
}

export type MaintenanceOrderType = 'corrective' | 'preventive'
export type MaintenanceOrderStatus = 'open' | 'in_progress' | 'done' | 'cancelled'
export type MaintenanceOrderPriority = 'low' | 'medium' | 'high' | 'urgent'

export type MaintenanceOrderRecord = {
  id: string
  projectId: string
  facilityId: string
  assetId: Nullable<string>
  title: string
  description: Nullable<string>
  type: MaintenanceOrderType
  status: MaintenanceOrderStatus
  priority: Nullable<MaintenanceOrderPriority>
  reportedBy: Nullable<string>
  assignedTo: Nullable<string>
  dueDate: Nullable<Date>
  completedAt: Nullable<Date>
  createdAt: Date
  updatedAt: Date
}

export type DocumentCategory = 'drawing' | 'manual' | 'art' | 'other'

export type FacilityDocumentRecord = {
  id: string
  projectId: string
  facilityId: string
  assetId: Nullable<string>
  spaceId: Nullable<string>
  title: string
  category: Nullable<DocumentCategory>
  description: Nullable<string>
  /** References Speckle's own blob storage - see modules/blobstorage. */
  blobId: string
  fileName: string
  fileSize: Nullable<number>
  uploadedBy: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type SensorType =
  | 'temperature'
  | 'humidity'
  | 'co2'
  | 'occupancy'
  | 'power'
  | 'pressure'
  | 'other'
export type SensorStatus = 'active' | 'inactive'

export type SensorRecord = {
  id: string
  projectId: string
  facilityId: string
  assetId: Nullable<string>
  spaceId: Nullable<string>
  name: string
  type: SensorType
  unit: Nullable<string>
  manufacturer: Nullable<string>
  model: Nullable<string>
  serialNumber: Nullable<string>
  status: SensorStatus
  /** bcrypt hash of the device API key - never exposed over GraphQL. */
  apiKeyHash: string
  lastReadingValue: Nullable<number>
  lastReadingAt: Nullable<Date>
  createdAt: Date
  updatedAt: Date
}

export type SensorReadingRecord = {
  id: number
  sensorId: string
  projectId: string
  ts: Date
  value: number
}

export type EnergyReadingRecord = {
  id: string
  assetId: string
  projectId: string
  ts: Date
  powerKw: number
  energyKwhInterval: number
  cumulativeKwh: number
  costInterval: number
  cumulativeCost: number
}
