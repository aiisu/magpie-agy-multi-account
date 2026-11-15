import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

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
    const result = message.method === 'initialize' ? { protocolVersion: 1, agentInfo: { version: '1.5.9' }, agentCapabilities: {} }
      : { sessionId: 'synthetic-session', models: { availableModels: [{ modelId: 'gemini-test-high', name: 'Gemini Test (High)' }] } }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }
}
