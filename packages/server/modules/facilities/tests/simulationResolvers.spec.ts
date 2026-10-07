import { db } from '@/db/knex'
import { DeviceStates, DeviceStateSegments } from '@/modules/core/dbSchema'
import { ensureFacilityFactory, newId } from '@/modules/facilities/services/facilities'
import { insertAssetFactory } from '@/modules/facilities/repositories/facilities'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { createTestStreams } from '@/test/speckle-helpers/streamHelper'
import { expect } from 'chai'
import gql from 'graphql-tag'

const setPowerMutation = gql`
  mutation ($input: SetAssetPowerInput!) {
    facilityMutations {
      setAssetPower(input: $input) {
        assetId
        powerState
        currentTemperature
        cumulativeKwh
      }
    }
  }
`

const setFaultMutation = gql`
  mutation ($input: SetDeviceFaultProfileInput!) {
    healthMutations {
      setDeviceFaultProfile(input: $input) {
        powerState
        degradationRate
      }
    }
  }
`

const updateFacilityMutation = gql`
  mutation ($input: UpdateFacilityInput!) {
    facilityMutations {
      update(input: $input) {
        energyTariffPerKwh
      }
    }
  }
`

const assetQuery = gql`
  query ($id: String!, $limit: Int) {
    asset(id: $id) {
      id
      deviceState {
        powerState
        degradationRate
        cumulativeKwh
        updatedAt
      }
      telemetryHistory(limit: $limit) {
        ts
        temperature
        powerState
      }
      energyHistory(limit: $limit) {
        ts
        energyKwhInterval
        cumulativeKwh
      }
      healthSignals {
        metric
      }
    }
  }
`

const dashboardQuery = gql`
  query ($projectId: String!, $limit: Int) {
    project(id: $projectId) {
      facility {
        dashboard {
          assetsOn
          currentPowerKw
          cumulativeKwh
          series(limit: $limit) {
            ts
            powerKw
          }
        }
        healthSignals {
          metric
        }
      }
    }
  }
`

const countSegments = async (assetId: string) => {
  const [{ count }] = await db(DeviceStateSegments.name)
    .where(DeviceStateSegments.withoutTablePrefix.col.assetId, assetId)
    .count()
  return parseInt(String(count))
}

/**
 * The device simulation computed on read from event segments - see
 * speckle-digitaltwin-console/.ai/plans/2026-10-07-simulacao-sob-demanda.md.
 */
describe('Facilities simulation on demand @facilities', () => {
  const owner: BasicTestUser = { name: 'simulation owner', email: '', id: '' }
  const outsider: BasicTestUser = { name: 'simulation outsider', email: '', id: '' }
  const project: BasicTestStream = {
    name: 'simulation project',
    isPublic: false,
    ownerId: '',
    id: ''
  }

  let assetId: string
  let ownerApollo: TestApolloServer
  let outsiderApollo: TestApolloServer

  before(async () => {
    await beforeEachContext()
    await createTestUsers([owner, outsider])
    await createTestStreams([[project, owner]])

    const facility = await ensureFacilityFactory({ db })({ projectId: project.id })
    const now = new Date()
    assetId = newId()
    await insertAssetFactory({ db })({
      id: assetId,
      projectId: project.id,
      facilityId: facility.id,
      tagNumber: 'AC-01',
      identityCode: `NXT-TEST-${assetId}`,
      name: 'Split AC',
      assetTypeId: null,
      assetClassId: null,
      spaceId: null,
      state: null,
      tenure: null,
      currentObjectId: null,
      currentVersionId: null,
      installDate: null,
      warrantyStartDate: null,
      serialNumber: null,
      barCode: null,
      extendedAttributes: {},
      createdAt: now,
      updatedAt: now
    })

    ownerApollo = await testApolloServer({ authUserId: owner.id })
    outsiderApollo = await testApolloServer({ authUserId: outsider.id })
  })

  it('has no simulated state before the first event', async () => {
    const res = await ownerApollo.execute(assetQuery, { id: assetId, limit: 5 })
    expect(res).to.not.haveGraphQLErrors()
    expect(res.data?.asset?.deviceState).to.equal(null)
    expect(res.data?.asset?.telemetryHistory).to.deep.equal([])
    expect(res.data?.asset?.healthSignals).to.deep.equal([])
  })

  it('records one segment and mirrors device_states when turned on', async () => {
    const res = await ownerApollo.execute(setPowerMutation, {
      input: { assetId, powerState: 'on' }
    })
    expect(res).to.not.haveGraphQLErrors()
    const state = res.data?.facilityMutations?.setAssetPower
    expect(state?.powerState).to.equal('on')
    expect(state?.currentTemperature).to.be.closeTo(28, 0.5)
    expect(await countSegments(assetId)).to.equal(1)
    const mirror = await db(DeviceStates.name)
      .where(DeviceStates.withoutTablePrefix.col.assetId, assetId)
      .first()
    expect(mirror?.powerState).to.equal('on')
  })

  it('computes the live state and the history from the segments', async () => {
    const res = await ownerApollo.execute(assetQuery, { id: assetId, limit: 5 })
    expect(res).to.not.haveGraphQLErrors()
    const asset = res.data?.asset
    expect(asset?.deviceState?.powerState).to.equal('on')
    // Readings sit on the 15s grid, most recent first
    const telemetry = asset?.telemetryHistory ?? []
    expect(telemetry.length).to.be.at.most(5)
    for (const r of telemetry) {
      expect(new Date(r.ts).getTime() % 15000).to.equal(0)
    }
    for (let i = 1; i < telemetry.length; i++) {
      expect(new Date(telemetry[i - 1].ts).getTime()).to.be.greaterThan(
        new Date(telemetry[i].ts).getTime()
      )
    }
  })

  it('applies a fault profile as a new segment, without command latency', async () => {
    const res = await ownerApollo.execute(setFaultMutation, {
      input: { assetId, degradationRate: 0.4 }
    })
    expect(res).to.not.haveGraphQLErrors()
    expect(res.data?.healthMutations?.setDeviceFaultProfile).to.deep.equal({
      powerState: 'on',
      degradationRate: 0.4
    })
    expect(await countSegments(assetId)).to.equal(2)
  })

  it('opens a segment per simulated asset only when the tariff changes', async () => {
    const same = await ownerApollo.execute(updateFacilityMutation, {
      input: { projectId: project.id, energyTariffPerKwh: 0.75 }
    })
    expect(same).to.not.haveGraphQLErrors()
    expect(await countSegments(assetId)).to.equal(2)

    const changed = await ownerApollo.execute(updateFacilityMutation, {
      input: { projectId: project.id, energyTariffPerKwh: 1.2 }
    })
    expect(changed).to.not.haveGraphQLErrors()
    expect(await countSegments(assetId)).to.equal(3)
    const latest = await db(DeviceStateSegments.name)
      .where(DeviceStateSegments.withoutTablePrefix.col.assetId, assetId)
      .orderBy(DeviceStateSegments.withoutTablePrefix.col.id, 'desc')
      .first()
    expect(latest?.tariffPerKwh).to.equal(1.2)
    expect(latest?.degradationRate).to.equal(0.4) // previous parameters carried over
  })

  it('rolls the facility dashboard up from the computed states', async () => {
    const res = await ownerApollo.execute(dashboardQuery, {
      projectId: project.id,
      limit: 3
    })
    expect(res).to.not.haveGraphQLErrors()
    const dashboard = res.data?.project?.facility?.dashboard
    expect(dashboard?.assetsOn).to.equal(1)
    expect(dashboard?.currentPowerKw).to.be.greaterThan(0)
    expect(dashboard?.series.length).to.be.at.most(3)
  })

  it('refuses history limits above the cap', async () => {
    const res = await ownerApollo.execute(assetQuery, { id: assetId, limit: 1001 })
    expect(res).to.haveGraphQLErrors()
  })

  it('blocks a user without access to the project', async () => {
    const control = await outsiderApollo.execute(setFaultMutation, {
      input: { assetId, degradationRate: 0.9 }
    })
    expect(control).to.haveGraphQLErrors()
    expect(await countSegments(assetId)).to.equal(3)

    const read = await outsiderApollo.execute(assetQuery, { id: assetId, limit: 5 })
    expect(read).to.haveGraphQLErrors()
    expect(read.data?.asset).to.not.be.ok
  })
})
