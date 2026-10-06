import type { Knex } from 'knex'
import { Roles } from '@speckle/shared'
import { StreamAcl, Streams } from '@/modules/core/dbSchema'
import { BadRequestError } from '@/modules/shared/errors'

/**
 * OFFICIO fork: a user can't own two projects with the same name (case and
 * surrounding spaces ignored). Repeated clicks on "Criar" used to leave
 * identical projects behind. Applied on create and on rename; projects the
 * user only collaborates on don't count.
 */
export const normalizeProjectName = (name: string) =>
  name.trim().toLocaleLowerCase('pt-BR')

export const assertUniqueProjectNameFactory =
  (deps: { db: Knex }) =>
  async (p: {
    ownerIds: string[]
    name: string | null | undefined
    exceptProjectId?: string
  }) => {
    const name = p.name?.trim()
    if (!name || !p.ownerIds.length) return

    const q = deps
      .db(Streams.name)
      .join(StreamAcl.name, StreamAcl.col.resourceId, Streams.col.id)
      .whereIn(StreamAcl.col.userId, p.ownerIds)
      .andWhere(StreamAcl.col.role, Roles.Stream.Owner)
      .andWhereRaw(`lower(btrim(${Streams.col.name})) = ?`, [
        normalizeProjectName(name)
      ])
      .first<{ id: string } | undefined>(Streams.col.id)
    if (p.exceptProjectId) q.andWhereNot(Streams.col.id, p.exceptProjectId)

    if (await q) {
      throw new BadRequestError(`Já existe um projeto chamado "${name}"`)
    }
  }

/** Owners of a project (a rename must stay unique for each of them). */
export const getProjectOwnerIdsFactory =
  (deps: { db: Knex }) => async (p: { projectId: string }) =>
    (
      await deps
        .db(StreamAcl.name)
        .where(StreamAcl.col.resourceId, p.projectId)
        .andWhere(StreamAcl.col.role, Roles.Stream.Owner)
        .select<{ userId: string }[]>(StreamAcl.col.userId)
    ).map((r) => r.userId)
