import { expect } from 'chai'
import gql from 'graphql-tag'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'

/**
 * OFFICIO fork: a user can't own two projects with the same name (case and
 * surrounding spaces ignored), on create and on rename.
 */

const createMutation = gql`
  mutation ($input: ProjectCreateInput) {
    projectMutations {
      create(input: $input) {
        id
        name
      }
    }
  }
`

const updateMutation = gql`
  mutation ($update: ProjectUpdateInput!) {
    projectMutations {
      update(update: $update) {
        id
        name
      }
    }
  }
`

describe('Project names are unique per owner @core', () => {
  const ana: BasicTestUser = { name: 'ana nomes', email: '', id: '' }
  const bia: BasicTestUser = { name: 'bia nomes', email: '', id: '' }
  let asAna: TestApolloServer
  let asBia: TestApolloServer

  before(async () => {
    await beforeEachContext()
    await createTestUsers([ana, bia])
    asAna = await testApolloServer({ authUserId: ana.id })
    asBia = await testApolloServer({ authUserId: bia.id })
  })

  const create = (as: TestApolloServer, name: string) =>
    as.execute(createMutation, { input: { name } })

  it('refuses a second project with the same name for the same owner', async () => {
    const first = await create(asAna, 'Teatro Cidade')
    expect(first.errors).to.be.undefined

    for (const repeated of ['Teatro Cidade', '  teatro cidade  ', 'TEATRO CIDADE']) {
      const res = await create(asAna, repeated)
      expect(res.errors?.[0].message, repeated).to.contain(
        'Já existe um projeto chamado'
      )
    }
  })

  it('lets another user use the same name', async () => {
    const res = await create(asBia, 'Teatro Cidade')
    expect(res.errors).to.be.undefined
  })

  it('refuses renaming onto an existing name, but allows keeping its own', async () => {
    const other = await create(asAna, 'Hospital Norte')
    const id = other.data!.projectMutations.create.id as string

    const clash = await asAna.execute(updateMutation, {
      update: { id, name: ' teatro CIDADE ' }
    })
    expect(clash.errors?.[0].message).to.contain('Já existe um projeto chamado')

    const same = await asAna.execute(updateMutation, {
      update: { id, name: 'Hospital Norte' }
    })
    expect(same.errors).to.be.undefined

    const description = await asAna.execute(updateMutation, {
      update: { id, description: 'sem mudar o nome' }
    })
    expect(description.errors).to.be.undefined
  })
})
