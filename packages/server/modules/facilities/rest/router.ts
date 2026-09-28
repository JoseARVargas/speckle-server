import { Router } from 'express'
import bcrypt from 'bcrypt'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import {
  getSensorByIdFactory,
  updateSensorFactory,
  insertSensorReadingFactory
} from '@/modules/facilities/repositories/sensors'

/**
 * Reading ingestion for a physical sensor/gateway, which has no Speckle
 * user session to authenticate a GraphQL mutation with - the sensor's own
 * bcrypt-hashed API key (see services/sensors.ts) is the credential
 * instead. projectId has to be in the URL (not just sensorId) because
 * getProjectDbClient(projectId) is what picks the right regional database
 * before the sensor row can even be looked up.
 */
export const sensorsRouterFactory = (): Router => {
  const router = Router()

  router.post(
    '/api/facilities/sensors/:projectId/:sensorId/readings',
    async (req, res) => {
      const { projectId, sensorId } = req.params
      const body = req.body as {
        apiKey?: unknown
        value?: unknown
        ts?: unknown
      }
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey : null
      const value = typeof body.value === 'number' ? body.value : null
      if (!apiKey || value === null || !isFinite(value)) {
        res.status(400).json({ error: 'apiKey and a numeric value are required' })
        return
      }

      let projectDb
      try {
        projectDb = await getProjectDbClient({ projectId })
      } catch {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      const sensor = await getSensorByIdFactory({ db: projectDb })({ id: sensorId })
      if (!sensor || sensor.projectId !== projectId) {
        res.status(404).json({ error: 'Sensor not found' })
        return
      }

      const valid = await bcrypt.compare(apiKey, sensor.apiKeyHash)
      if (!valid) {
        res.status(401).json({ error: 'Invalid API key' })
        return
      }

      const ts =
        typeof body.ts === 'string' && !isNaN(new Date(body.ts).getTime())
          ? new Date(body.ts)
          : new Date()

      await insertSensorReadingFactory({ db: projectDb })({
        sensorId,
        projectId,
        ts,
        value
      })
      await updateSensorFactory({ db: projectDb })({
        id: sensorId,
        update: { lastReadingValue: value, lastReadingAt: ts }
      })

      res.status(201).json({ ok: true })
    }
  )

  return router
}
