import { moduleLogger } from '@/observability/logging'
import type { SpeckleModule } from '@/modules/shared/helpers/typeHelper'

export const init: SpeckleModule['init'] = () => {
  moduleLogger.info('🏢 Init facilities module')
}
