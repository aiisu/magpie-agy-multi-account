import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import net from 'node:net'

function control(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.AGY_BRIDGE_CONTROL_PORT) })
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.AGY_BRIDGE_TOKEN, ...payload }) + '\n'))
    let buffer = ''
    socket.on('data', text => {
      buffer += text
      if (!buffer.includes('\n')) return
      socket.end()
      resolve(JSON.parse(buffer.split('\n')[0]))
    })
  })
}

const args = process.argv.slice(2)
const credential = path.join(process.env.HOME, '.gemini/antigravity-cli/antigravity-oauth-token')
if (args.includes('--version')) {
  console.log('1.5.9')
} else if (args.includes('--help')) {
  console.log('--gemini-dir --no-default-skills --no-default-agents')
} else if (args.includes('--login')) {
  console.log('https://accounts.google.com/test?profile=' + path.basename(path.dirname(process.env.HOME)))
  for await (const code of createInterface({ input: process.stdin })) {
    await fs.mkdir(path.dirname(credential), { recursive: true, mode: 0o700 })
    await fs.writeFile(credential, JSON.stringify({ id_token_email: code.trim(),
      token: { refresh_token: 'synthetic-test-value' } }), { mode: 0o600 })
    console.log('Signed in')
    process.exit(0)
  }
} else if (args[0] === 'models') {
  if (!await fs.stat(credential).catch(() => null)) process.exit(1)
  console.log('gemini-test-high Gemini Test (High)')
} else if (args.includes('/usage')) {
  const account = JSON.parse(await fs.readFile(credential, 'utf8'))
  console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
    { displayName: 'Gemini models', buckets: [{ bucketId: '5h', remainingFraction: account.id_token_email.startsWith('first') ? 0.75 : 0.5 }] },
  ] } } }))
} else if (args[0] === 'acp') {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    if (process.env.AGY_TEST_TOOL && message.method === 'session/new') await control({ kind: 'list' })
    if (process.env.AGY_TEST_TOOL && message.method === 'session/prompt' &&
      !JSON.stringify(message.params).includes('REPLAY_RESULT_OK')) {
      void control({ kind: 'call', name: 'synthetic_tool', arguments: {} }).then(() => {
        console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }))
      })
      continue
    }
    if (message.method === 'session/prompt' && process.env.AGY_TEST_REPLY) {
      for (const text of process.env.AGY_TEST_REPLY) {
        console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'synthetic-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        } }))
      }
      console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }))
      continue
    }
    const result = message.method === 'initialize' ? { protocolVersion: 1, agentInfo: { version: '1.5.9' }, agentCapabilities: {} }
      : { sessionId: 'synthetic-session', models: { availableModels: [{ modelId: 'gemini-test-high', name: 'Gemini Test (High)' }] } }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }
}
