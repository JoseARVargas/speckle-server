import { db } from '@/db/knex'
import { StreamAcl } from '@/modules/core/dbSchema'
import { Roles } from '@/modules/core/helpers/mainConstants'
import { ForbiddenError } from '@/modules/shared/errors'
import { throwIfAuthNotOk } from '@/modules/shared/helpers/errorHelper'
import { throwIfResourceAccessNotAllowed } from '@/modules/core/helpers/token'
import { TokenResourceIdentifierType } from '@/modules/core/domain/tokens/types'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'

/**
 * Coordination writes (rule sets, requirements, runs) need the same right as
 * publishing to the Speckle project. Kept in this module so coordination
 * doesn't depend on the facilities (digital twin) module, which can be off.
 */
export async function assertCanManageCoordination(
  ctx: GraphQLContext,
  projectId: string
) {
  if (!ctx.userId) {
    throw new ForbiddenError('No userId provided')
  }
  throwIfResourceAccessNotAllowed({
    resourceId: projectId,
    resourceType: TokenResourceIdentifierType.Project,
    resourceAccessRules: ctx.resourceAccessRules
  })
  const canPublish = await ctx.authPolicies.project.canPublish({
    userId: ctx.userId,
    projectId
  })
  throwIfAuthNotOk(canPublish)
}

/**
 * Project configuration (CDE states, approvers) is the owner's call: the
 * token must reach the project and the user must own it.
 */
export async function assertProjectOwner(ctx: GraphQLContext, projectId: string) {
  await assertCanManageCoordination(ctx, projectId)
  const acl = await db(StreamAcl.name)
    .where({ resourceId: projectId, userId: ctx.userId! })
    .first()
  if (acl?.role !== Roles.Stream.Owner) {
    throw new ForbiddenError('Só o dono do projeto pode alterar esta configuração')
  }
}
