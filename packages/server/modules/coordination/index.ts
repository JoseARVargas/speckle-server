import { moduleLogger } from '@/observability/logging'
import type { SpeckleModule } from '@/modules/shared/helpers/typeHelper'
import { db } from '@/db/knex'
import { isTestEnv } from '@/modules/shared/helpers/envHelper'
import { startCoordinationWorker } from '@/modules/coordination/services/coordinationRunner'
import { startClashWorker } from '@/modules/coordination/services/coordinationClash'

/**
 * BIM coordination (Model Check + IDS). Independent of the facilities
 * (digital twin) module, so a server can run it with facilities off.
 */
export const init: SpeckleModule['init'] = ({ isInitial }) => {
  moduleLogger.info('📐 Init coordination module')
  // Only start the queue worker once per process, not on every test re-init.
  if (isInitial) {
    startCoordinationWorker({ db, pollQueue: !isTestEnv() })
    startClashWorker({ db, pollQueue: !isTestEnv() })
  }
}
