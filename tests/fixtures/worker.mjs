import fs from 'node:fs/promises'
import path from 'node:path'

const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    if (request.headers.get('authorization') !== 'Bearer ' + process.env.AGY_ACCOUNT_CONTROL_TOKEN) return new Response(null, { status: 403 })
    const location = new URL(request.url).pathname
    if (location === '/status') return Response.json({ busy: false })
    const identity = JSON.parse(await fs.readFile(path.join(process.env.HOME, '.gemini/antigravity-cli/antigravity-oauth-token'), 'utf8')).id_token_email
    if (location === '/rpc') {
      const input = await request.json()
      if (input.method === 'models') return Response.json({ [identity]: { id: identity } })
      if (input.method === 'usage') return Response.json({ user: identity, windows: [] })
      return Response.json({ home: process.env.HOME, state: process.env.AGY_BRIDGE_STATE_FILE })
    }
    if (request.headers.get('x-agy-request-path') === '/stream') {
      let timer
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(identity))
          timer = setInterval(() => controller.enqueue(new TextEncoder().encode('.')), 20)
        },
        cancel() { clearInterval(timer) },
      }))
    }
    return Response.json({ identity, path: request.headers.get('x-agy-request-path'), body: await request.text() })
  },
})
process.stdout.write(JSON.stringify({ port: server.port }) + '\n')
