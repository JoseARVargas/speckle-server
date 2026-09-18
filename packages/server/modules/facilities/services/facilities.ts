import type { Knex } from 'knex'
import cryptoRandomString from 'crypto-random-string'
import type { FacilityRecord } from '@/modules/facilities/helpers/types'
import {
  getFacilityByProjectIdFactory,
  upsertFacilityFactory
} from '@/modules/facilities/repositories/facilities'

/**
 * There's no explicit "create a facility" step in the UI - the registry is
 * lazily provisioned the first time anything (a floor, space, system or
 * asset) is registered against a project, keyed 1:1 by projectId.
 */
export const ensureFacilityFactory =
  (deps: { db: Knex }) =>
  async (params: { projectId: string }): Promise<FacilityRecord> => {
    const existing = await getFacilityByProjectIdFactory(deps)({
      projectId: params.projectId
    })
    if (existing) return existing

    return await upsertFacilityFactory(deps)({
      id: cryptoRandomString({ length: 10 }),
      projectId: params.projectId,
      name: params.projectId,
      tagSourceProperty: 'IfcTag',
      energyTariffPerKwh: 0.75,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  }

export const newId = () => cryptoRandomString({ length: 10 })
