import { AntigravityBridgePlugin, accountBridgeStatus, releaseAccountIdle } from '../index.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

const plugin = await AntigravityBridgePlugin()
const token = process.env.AGY_ACCOUNT_CONTROL_TOKEN
if (!token) throw new Error('Missing worker control token')
let login = null
let requests = 0
let closing = false
let usagePending = null
const usageFile = path.join(process.env.XDG_STATE_HOME, 'usage.json')
let lastUsage = await fs.readFile(usageFile, 'utf8').then(JSON.parse).catch(() => null)

const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  async fetch(request) {
    if (request.headers.get('authorization') !== 'Bearer ' + token) return new Response(null, { status: 403 })
    const pathname = new URL(request.url).pathname
    if (pathname === '/status') return Response.json({ ...accountBridgeStatus(), requests, login: !!login })
    if (closing) return new Response(null, { status: 503 })
    requests++
    try {
      if (pathname === '/fetch') {
        if (usagePending) await usagePending
        const options = await plugin.auth.loader()
        const headers = new Headers(request.headers)
        headers.delete('authorization')
        headers.delete('host')
        const apiPath = headers.get('x-agy-request-path') || '/v1/messages'
        headers.delete('x-agy-request-path')
        return await options.fetch('agy://local' + apiPath, {
          method: 'POST', body: await request.text(), headers, signal: request.signal,
        })
      }
      const input = await request.json()
      if (input.method === 'models') {
        return Response.json(await plugin.provider.models())
      }
      if (input.method === 'usage') {
        if (accountBridgeStatus().busy || requests > 1) return Response.json({ ...(lastUsage || { windows: [] }),
          signIn: 'kept', error: 'Usage refresh deferred during an active CLI turn; showing the last reading if available.' })
        usagePending = (async () => {
          await releaseAccountIdle()
          const result = await plugin.auth.usage()
          if (!result.error) {
            lastUsage = result
            await fs.writeFile(usageFile, JSON.stringify(result), { mode: 0o600 })
          }
          return result
        })()
        try { return Response.json(await usagePending) }
        finally { usagePending = null }
      }
      if (input.method === 'authorize') {
        const result = await plugin.auth.methods[0].authorize()
        if (result.type === 'failed') return Response.json(result)
        login = result
        return Response.json({ url: result.url, instructions: result.instructions, method: result.method })
      }
      if (input.method === 'finish') {
        if (!login) throw new Error('This login session has ended; start again.')
        const current = login
        login = null
        return Response.json(await current.callback(input.code, { signal: request.signal }))
      }
      return new Response(null, { status: 404 })
    } catch (error) {
      return Response.json({ error: String(error.message || 'CLI account request failed') }, { status: error.statusCode || 502 })
    } finally {
      requests--
    }
  },
})

process.stdout.write(JSON.stringify({ port: server.port }) + '\n')
const parent = Number(process.env.AGY_ACCOUNT_PARENT_PID)
if (parent > 1) setInterval(() => {
  try { process.kill(parent, 0) } catch { process.kill(-process.pid, 'SIGKILL') }
}, 2000).unref()
process.once('SIGTERM', async () => {
  closing = true
  await releaseAccountIdle()
  server.stop(true)
  process.exit(0)
})
