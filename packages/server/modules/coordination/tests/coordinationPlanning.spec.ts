import { expect } from 'chai'
import gql from 'graphql-tag'
import { db } from '@/db/knex'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { createTestStreams } from '@/test/speckle-helpers/streamHelper'
import type { BasicTestBranch } from '@/test/speckle-helpers/branchHelper'
import { createTestBranch } from '@/test/speckle-helpers/branchHelper'
import { CoordDeliverableRequirements } from '@/modules/core/dbSchema'
import type { CoordDeliverableRecord } from '@/modules/coordination/helpers/planningTypes'
import { buildContainerName } from '@/modules/coordination/helpers/planningTypes'

/**
 * Information delivery planning (ISO 19650 MIDP/TIDP): naming lists,
 * deliverables with generated container names, TIDP filter, requirement
 * traceability, CSV import (all or nothing) and the access gates.
 */

const setCodesMutation = gql`
  mutation ($projectId: String!, $input: JSONObject!) {
    coordinationMutations {
      setNamingCodes(projectId: $projectId, input: $input) {
        field
        code
        description
      }
    }
  }
`

const DELIVERABLE_FIELDS = `
  id
  containerName
  title
  kind
  originator
  number
  status
  milestoneId
  dueDate
  effectiveDueDate
  responsibleUserId
  responsibleName
  modelId
  requirementIds
`

const createMutation = gql`
  mutation ($projectId: String!, $input: JSONObject!) {
    coordinationMutations {
      createDeliverable(projectId: $projectId, input: $input) { ${DELIVERABLE_FIELDS} }
    }
  }
`

const updateMutation = gql`
  mutation ($id: String!, $input: JSONObject!) {
    coordinationMutations {
      updateDeliverable(id: $id, input: $input) { ${DELIVERABLE_FIELDS} }
    }
  }
`

const deleteMutation = gql`
  mutation ($id: String!) {
    coordinationMutations {
      deleteDeliverable(id: $id)
    }
  }
`

const statusMutation = gql`
  mutation ($id: String!, $status: String!) {
    coordinationMutations {
      setDeliverableStatus(id: $id, status: $status) {
        id
        status
      }
    }
  }
`

const importMutation = gql`
  mutation ($projectId: String!, $rows: [JSONObject!]!) {
    coordinationMutations {
      importDeliverables(projectId: $projectId, rows: $rows) {
        imported
        errors {
          row
          message
        }
      }
    }
  }
`

const listQuery = gql`
  query ($projectId: String!, $originator: String, $status: String) {
    project(id: $projectId) {
      coordination {
        deliverables(originator: $originator, status: $status) {
          containerName
          originator
        }
        deliverableCount(originator: $originator, status: $status)
      }
    }
  }
`

const traceQuery = gql`
  query ($projectId: String!, $id: String!) {
    project(id: $projectId) {
      coordination {
        deliverable(id: $id) {
          containerName
          milestone {
            name
          }
          requirements {
            code
            deliverables {
              containerName
            }
          }
        }
      }
    }
  }
`

const sourceMutation = gql`
  mutation ($projectId: String!, $input: CoordRequirementSourceInput!) {
    coordinationMutations {
      createRequirementSource(projectId: $projectId, input: $input) {
        id
      }
    }
  }
`
const milestoneMutation = gql`
  mutation ($projectId: String!, $input: CoordMilestoneInput!) {
    coordinationMutations {
      createMilestone(projectId: $projectId, input: $input) {
        id
      }
    }
  }
`
const requirementMutation = gql`
  mutation ($projectId: String!, $input: CoordRequirementInput!) {
    coordinationMutations {
      createRequirement(projectId: $projectId, input: $input) {
        id
      }
    }
  }
`

const codes = {
  project: [{ code: 'TEA', description: 'Teatro' }],
  originator: [
    { code: 'PHD', description: 'PHD Engenharia' },
    { code: 'ARQ', description: 'Arquitetura' }
  ],
  volume: [{ code: 'ZZ' }, { code: 'B1' }],
  level: [{ code: 'ZZ' }, { code: '01' }],
  type: [{ code: 'M3', description: 'Modelo 3D' }, { code: 'DR' }],
  role: [{ code: 'S', description: 'Estrutura' }, { code: 'A' }]
}

const deliverables = () => db<CoordDeliverableRecord>('coord_deliverables')
const links = (deliverableId: string) =>
  db<{ deliverableId: string; requirementId: string }>(
    CoordDeliverableRequirements.name
  ).where({ deliverableId })

const base = {
  title: 'Modelo estrutural',
  kind: 'model',
  project: 'TEA',
  originator: 'PHD',
  volume: 'ZZ',
  level: 'ZZ',
  type: 'M3',
  role: 'S'
}

describe('Coordination planning @coordination', () => {
  const owner: BasicTestUser = { name: 'planning owner', email: '', id: '' }
  const outsider: BasicTestUser = { name: 'planning outsider', email: '', id: '' }
  const project: BasicTestStream = {
    name: 'Planning project',
    isPublic: false,
    ownerId: '',
    id: ''
  }
  const other: BasicTestStream = { name: 'Other', isPublic: false, ownerId: '', id: '' }
  const model: BasicTestBranch = {
    name: 'estrutura',
    streamId: '',
    authorId: '',
    id: ''
  }
  let apollo: TestApolloServer
  let outsiderApollo: TestApolloServer
  let milestoneId: string
  let otherMilestoneId: string
  let requirementId: string

  /** A deliverable of the test project by its code; fails the test if missing. */
  const byName = async (containerName: string) => {
    const row = await deliverables()
      .where({ projectId: project.id, containerName })
      .first()
    if (!row) throw new Error(`deliverable ${containerName} not found`)
    return row
  }

  before(async () => {
    await beforeEachContext()
    await createTestUsers([owner, outsider])
    await createTestStreams([
      [project, owner],
      [other, outsider]
    ])
    await createTestBranch({ branch: model, stream: project, owner })
    apollo = await testApolloServer({ authUserId: owner.id })
    outsiderApollo = await testApolloServer({ authUserId: outsider.id })

    const source = await apollo.execute(sourceMutation, {
      projectId: project.id,
      input: { kind: 'EIR', title: 'EIR Teatro' }
    })
    const milestone = await apollo.execute(milestoneMutation, {
      projectId: project.id,
      input: { name: 'Executivo', dueDate: '2026-12-15T00:00:00.000Z' }
    })
    milestoneId = milestone.data!.coordinationMutations.createMilestone.id
    const requirement = await apollo.execute(requirementMutation, {
      projectId: project.id,
      input: {
        sourceId: source.data!.coordinationMutations.createRequirementSource.id,
        milestoneId,
        code: 'EIR-STR-01',
        title: 'Pilares com classe de concreto'
      }
    })
    requirementId = requirement.data!.coordinationMutations.createRequirement.id
    const otherMilestone = await outsiderApollo.execute(milestoneMutation, {
      projectId: other.id,
      input: { name: 'Alheio' }
    })
    otherMilestoneId = otherMilestone.data!.coordinationMutations.createMilestone.id
  })

  it('builds container names from the ISO 19650-2 fields', () => {
    expect(
      buildContainerName(
        {
          project: 'TEA',
          originator: 'PHD',
          volume: 'ZZ',
          level: '01',
          type: 'M3',
          role: 'S'
        },
        7
      )
    ).to.equal('TEA-PHD-ZZ-01-M3-S-0007')
  })

  it('validates and stores the naming lists; outsiders are refused', async () => {
    const bad = await apollo.execute(setCodesMutation, {
      projectId: project.id,
      input: { ...codes, role: [{ code: 'S-1' }] }
    })
    expect(bad.errors?.[0].message).to.contain('letras ou números')

    const repeated = await apollo.execute(setCodesMutation, {
      projectId: project.id,
      input: { ...codes, role: [{ code: 's' }, { code: 'S' }] }
    })
    expect(repeated.errors?.[0].message).to.contain('repetido')

    const denied = await outsiderApollo.execute(setCodesMutation, {
      projectId: project.id,
      input: codes
    })
    expect(denied.errors).to.not.be.undefined

    const ok = await apollo.execute(setCodesMutation, {
      projectId: project.id,
      input: { ...codes, level: [{ code: 'zz' }, { code: '01' }] }
    })
    expect(ok.errors).to.be.undefined
    const stored = ok.data!.coordinationMutations.setNamingCodes
    expect(stored).to.have.length(11)
    // codes are stored in upper case
    expect(
      stored.filter((c: { field: string }) => c.field === 'level')[0].code
    ).to.equal('ZZ')
  })

  it('creates deliverables with sequential numbers and checks every reference', async () => {
    const first = await apollo.execute(createMutation, {
      projectId: project.id,
      input: {
        ...base,
        milestoneId,
        modelId: model.id,
        responsibleUserId: owner.id,
        requirementIds: [requirementId]
      }
    })
    expect(first.errors).to.be.undefined
    const d1 = first.data!.coordinationMutations.createDeliverable
    expect(d1.containerName).to.equal('TEA-PHD-ZZ-ZZ-M3-S-0001')
    expect(d1.status).to.equal('planned')
    expect(d1.responsibleName).to.equal(owner.name)
    // no own due date: the milestone's applies
    expect(d1.dueDate).to.equal(null)
    expect(new Date(d1.effectiveDueDate).toISOString()).to.equal(
      '2026-12-15T00:00:00.000Z'
    )

    const second = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { ...base, title: 'Modelo de fundações' }
    })
    expect(second.data!.coordinationMutations.createDeliverable.containerName).to.equal(
      'TEA-PHD-ZZ-ZZ-M3-S-0002'
    )

    const duplicate = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { ...base, number: 2 }
    })
    expect(duplicate.errors?.[0].message).to.contain('TEA-PHD-ZZ-ZZ-M3-S-0002')

    const notInList = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { ...base, originator: 'XYZ' }
    })
    expect(notInList.errors?.[0].message).to.contain('originador "XYZ"')

    // A01: references from another project, or a non-member as responsible
    const foreignMilestone = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { ...base, milestoneId: otherMilestoneId }
    })
    expect(foreignMilestone.errors?.[0].message).to.contain('Marco não pertence')
    const nonMember = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { ...base, responsibleUserId: outsider.id }
    })
    expect(nonMember.errors?.[0].message).to.contain('colaborador do projeto')
    const foreignRequirement = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { ...base, requirementIds: ['nope000000'] }
    })
    expect(foreignRequirement.errors?.[0].message).to.contain('Requisito não pertence')

    const denied = await outsiderApollo.execute(createMutation, {
      projectId: project.id,
      input: base
    })
    expect(denied.errors).to.not.be.undefined
  })

  it('shows the TIDP of an originator and traces requirements to deliverables', async () => {
    await apollo.execute(createMutation, {
      projectId: project.id,
      input: { ...base, originator: 'ARQ', role: 'A', title: 'Modelo de arquitetura' }
    })
    const tidp = await apollo.execute(listQuery, {
      projectId: project.id,
      originator: 'phd'
    })
    expect(tidp.errors).to.be.undefined
    const coordination = tidp.data!.project.coordination
    expect(coordination.deliverableCount).to.equal(2)
    expect(
      coordination.deliverables.every(
        (d: { originator: string }) => d.originator === 'PHD'
      )
    ).to.equal(true)

    const midp = await apollo.execute(listQuery, { projectId: project.id })
    expect(midp.data!.project.coordination.deliverableCount).to.equal(3)
    const unknownStatus = await apollo.execute(listQuery, {
      projectId: project.id,
      status: 'whatever'
    })
    expect(unknownStatus.data!.project.coordination.deliverableCount).to.equal(0)

    const [first] = coordination.deliverables
    const all = await byName(first.containerName)
    const trace = await apollo.execute(traceQuery, {
      projectId: project.id,
      id: all.id
    })
    const deliverable = trace.data!.project.coordination.deliverable
    expect(deliverable.milestone.name).to.equal('Executivo')
    expect(deliverable.requirements[0].code).to.equal('EIR-STR-01')
    expect(deliverable.requirements[0].deliverables).to.deep.equal([
      { containerName: 'TEA-PHD-ZZ-ZZ-M3-S-0001' }
    ])

    // another project can't read it through its own coordination
    const crossRead = await outsiderApollo.execute(traceQuery, {
      projectId: other.id,
      id: all.id
    })
    expect(crossRead.data?.project.coordination.deliverable).to.equal(null)
  })

  it('keeps the number while the codes stay and renumbers a new series', async () => {
    const row = await byName('TEA-PHD-ZZ-ZZ-M3-S-0002')
    const sameCodes = await apollo.execute(updateMutation, {
      id: row.id,
      input: { ...base, title: 'Fundações (rev.)', status: 'in_progress' }
    })
    expect(sameCodes.errors).to.be.undefined
    expect(sameCodes.data!.coordinationMutations.updateDeliverable).to.include({
      containerName: 'TEA-PHD-ZZ-ZZ-M3-S-0002',
      title: 'Fundações (rev.)',
      status: 'in_progress'
    })

    const newSeries = await apollo.execute(updateMutation, {
      id: row.id,
      input: { ...base, type: 'DR', kind: 'drawing' }
    })
    expect(
      newSeries.data!.coordinationMutations.updateDeliverable.containerName
    ).to.equal('TEA-PHD-ZZ-ZZ-DR-S-0001')

    const outsiderUpdate = await outsiderApollo.execute(updateMutation, {
      id: row.id,
      input: base
    })
    expect(outsiderUpdate.errors).to.not.be.undefined
  })

  it('refuses to drop a naming code that deliverables still use', async () => {
    const res = await apollo.execute(setCodesMutation, {
      projectId: project.id,
      input: { ...codes, originator: [{ code: 'PHD' }] }
    })
    expect(res.errors?.[0].message).to.contain('"ARQ" é usado por entregáveis')
  })

  it('imports a CSV all or nothing, reporting every bad row', async () => {
    const rows = [
      { ...base, title: 'Importado 1', milestone: 'Executivo' },
      { ...base, title: 'Importado 2', requirementCodes: ['EIR-STR-01'] },
      { ...base, title: 'Marco errado', milestone: 'Inexistente' },
      { ...base, title: 'Código fora', role: 'X' },
      { ...base, title: 'Requisito errado', requirementCodes: ['NAO-EXISTE'] },
      { ...base, title: 'Já existe', number: 1 },
      { ...base, title: 'Sem tipo', type: undefined }
    ]
    const rejected = await apollo.execute(importMutation, {
      projectId: project.id,
      rows
    })
    expect(rejected.errors).to.be.undefined
    const result = rejected.data!.coordinationMutations.importDeliverables
    expect(result.imported).to.equal(0)
    expect(result.errors.map((e: { row: number }) => e.row)).to.deep.equal([
      3, 4, 5, 6, 7
    ])
    expect(result.errors[0].message).to.contain('Marco "Inexistente"')
    const before = await deliverables().where({ projectId: project.id })
    expect(before).to.have.length(3)

    const fixed = await apollo.execute(importMutation, {
      projectId: project.id,
      rows: rows.slice(0, 2)
    })
    expect(fixed.data!.coordinationMutations.importDeliverables).to.deep.equal({
      imported: 2,
      errors: []
    })
    const imported = await deliverables()
      .where({ projectId: project.id })
      .whereIn('title', ['Importado 1', 'Importado 2'])
      .orderBy('containerName')
    // the S/M3 series already had 0001 (0002 moved to DR): continues from 0002
    expect(imported.map((d) => d.containerName)).to.deep.equal([
      'TEA-PHD-ZZ-ZZ-M3-S-0002',
      'TEA-PHD-ZZ-ZZ-M3-S-0003'
    ])
    expect(imported[0].milestoneId).to.equal(milestoneId)
    const linked = await links(imported[1].id)
    expect(linked.map((l) => l.requirementId)).to.deep.equal([requirementId])

    const repeatedInBatch = await apollo.execute(importMutation, {
      projectId: project.id,
      rows: [
        { ...base, number: 50 },
        { ...base, number: 50 }
      ]
    })
    expect(
      repeatedInBatch.data!.coordinationMutations.importDeliverables.errors[0]
    ).to.deep.equal({
      row: 2,
      message: 'Código TEA-PHD-ZZ-ZZ-M3-S-0050 repetido (linha 1)'
    })

    const denied = await outsiderApollo.execute(importMutation, {
      projectId: project.id,
      rows: [base]
    })
    expect(denied.errors).to.not.be.undefined
  })

  it('changes status and deletes, removing the requirement links', async () => {
    const row = await byName('TEA-PHD-ZZ-ZZ-M3-S-0001')
    const invalid = await apollo.execute(statusMutation, { id: row.id, status: 'done' })
    expect(invalid.errors?.[0].message).to.contain('Status de entregável inválido')
    const accepted = await apollo.execute(statusMutation, {
      id: row.id,
      status: 'accepted'
    })
    expect(accepted.data!.coordinationMutations.setDeliverableStatus.status).to.equal(
      'accepted'
    )

    const outsiderDelete = await outsiderApollo.execute(deleteMutation, { id: row.id })
    expect(outsiderDelete.errors).to.not.be.undefined
    const deleted = await apollo.execute(deleteMutation, { id: row.id })
    expect(deleted.data!.coordinationMutations.deleteDeliverable).to.equal(true)
    expect(await links(row.id)).to.have.length(0)
  })
})
