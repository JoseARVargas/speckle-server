import { moduleLogger } from '@/observability/logging'
import type { SpeckleModule } from '@/modules/shared/helpers/typeHelper'
import { db } from '@/db/knex'
import { startSimulationWorker } from '@/modules/facilities/services/simulation'
import { sensorsRouterFactory } from '@/modules/facilities/rest/router'

export const init: SpeckleModule['init'] = ({ isInitial, app }) => {
  moduleLogger.info('🏢 Init facilities module')
  // Only start the ticking interval once per process, not on every test
  // re-init.
  if (isInitial) startSimulationWorker({ db })
  app.use(sensorsRouterFactory())
}
