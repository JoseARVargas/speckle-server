/* eslint-disable camelcase */
// Fixtures use Speckle's object format (speckle_type).
import gql from 'graphql-tag'
import { createTestCommit, createTestObject } from '@/test/speckle-helpers/commitHelper'
import type { BasicTestUser } from '@/test/authHelper'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'

/** Shared fixtures for the coordination specs. */

export const importRuleSetMutation = gql`
  mutation ($projectId: String!, $document: JSONObject!) {
    coordinationMutations {
      importRuleSet(projectId: $projectId, document: $document) {
        ruleSet {
          id
          draft {
            id
            rules {
              id
              code
            }
          }
        }
        createdRequirements
      }
    }
  }
`

export const publishMutation = gql`
  mutation ($ruleSetId: String!) {
    coordinationMutations {
      publishRuleSet(ruleSetId: $ruleSetId) {
        id
        version
        status
      }
    }
  }
`

export const bindingMutation = gql`
  mutation ($ruleSetId: String!, $modelId: String!, $autoRun: Boolean!, $pct: Float) {
    coordinationMutations {
      setRuleSetBinding(
        ruleSetId: $ruleSetId
        modelId: $modelId
        autoRun: $autoRun
        unkeyedBlockPct: $pct
      ) {
        modelId
        autoRun
        unkeyedBlockPct
      }
    }
  }
`

export const runCheckMutation = gql`
  mutation ($ruleSetId: String!, $modelId: String!, $versionId: String) {
    coordinationMutations {
      runCheck(ruleSetId: $ruleSetId, modelId: $modelId, versionId: $versionId) {
        id
        status
        trigger
        versionId
      }
    }
  }
`

export const exampleRuleSet = {
  name: 'EIR Estrutural — Executivo',
  milestone: 'Projeto Executivo',
  rules: [
    {
      code: 'EIR-STR-012',
      name: 'Pilares com classe de concreto',
      requirement: 'EIR 4.2 — Pilares com classe de concreto',
      where: [
        { path: 'properties.category', op: 'equals', value: 'Structural Columns' }
      ],
      check: [
        {
          path: '*.Classe do Concreto',
          match: 'suffix',
          op: 'in',
          value: ['C30', 'C35', 'C40']
        }
      ],
      severity: 'error',
      weight: 2
    },
    {
      code: 'EIR-STR-031',
      name: 'Nível de referência preenchido',
      requirement: 'EIR 5.1 — Nível de referência',
      where: [
        { path: 'properties.category', op: 'equals', value: 'Structural Columns' }
      ],
      check: [{ path: '*.Nível', op: 'exists' }],
      severity: 'error',
      weight: 1
    }
  ]
}

export const columnObject = (applicationId: string | null, concrete: string) => ({
  ...(applicationId ? { applicationId } : {}),
  speckle_type: 'Objects.Data.DataObject',
  name: `Pilar ${applicationId}`,
  properties: {
    category: 'Structural Columns',
    Parameters: {
      Type: {
        'Classe do Concreto': {
          name: 'Classe do Concreto',
          value: concrete,
          units: null
        },
        Nível: { name: 'Nível', value: 'Térreo', units: null }
      }
    }
  },
  displayValue: [{ referencedId: 'mesh', speckle_type: 'reference' }]
})

export const wallObject = (applicationId: string) => ({
  applicationId,
  speckle_type: 'Objects.Data.DataObject',
  properties: { category: 'Walls' },
  displayValue: [{ referencedId: 'mesh', speckle_type: 'reference' }]
})

/**
 * Creates a version on the project's "main" model whose root object has the
 * given elements as children (plus a bare mesh, which is not an element).
 */
export const createModelVersion = async (params: {
  project: BasicTestStream
  owner: BasicTestUser
  elements: Record<string, unknown>[]
  branchId?: string
}) => {
  const children = [
    ...params.elements,
    { speckle_type: 'Objects.Geometry.Mesh', vertices: [0, 0, 0], displayValue: [1] }
  ]
  const ids = await Promise.all(
    children.map((object) => createTestObject({ projectId: params.project.id, object }))
  )
  const rootId = await createTestObject({
    projectId: params.project.id,
    object: {
      speckle_type: 'Speckle.Core.Models.Collection',
      elements: ids.map((id) => ({ referencedId: id, speckle_type: 'reference' })),
      __closure: Object.fromEntries(ids.map((id) => [id, 1]))
    }
  })
  const commit = await createTestCommit(
    {
      id: '',
      objectId: rootId,
      streamId: params.project.id,
      authorId: params.owner.id,
      branchId: params.branchId ?? ''
    },
    { owner: params.owner, stream: params.project }
  )
  return { modelId: commit.branchId, versionId: commit.id }
}
