import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { pinoLogger } from 'hono-pino'
import { cors } from 'hono/cors'
import env from './core/env.js'

import api from './routes/api.js'
import auth from './routes/auth.js'
import schedule from './routes/schedule.js'

export const app = new Hono()
  .use(pinoLogger({ pino: { level: env.LOG_LEVEL } }))
  .use('/api/*', cors())

app.route('/api', api)
app.route('/api', auth)
app.route('/api', schedule)

app.get('/', (c) => {
  return c.text('Hello Hono!');
})

app.get('/health', (c) => {
  return c.json({ "status": "healthy" });
})

const isTest = process.argv[1] && process.argv[1].includes('test-api');
const isVercel = process.env.VERCEL === '1';

if (!isTest && !isVercel) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  serve({
    fetch: app.fetch,
    port
  }, (info) => {
    console.log(`Server is running on http://localhost:${info.port}`)
  })
}

export default app