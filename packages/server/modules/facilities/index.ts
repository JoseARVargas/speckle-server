import { moduleLogger } from '@/observability/logging'
import type { SpeckleModule } from '@/modules/shared/helpers/typeHelper'
import { sensorsRouterFactory } from '@/modules/facilities/rest/router'

export const init: SpeckleModule['init'] = ({ app }) => {
  moduleLogger.info('🏢 Init facilities module')
  // No background worker: the device simulation is computed on read from
  // event segments (services/simulationModel.ts).
  app.use(sensorsRouterFactory())
}
