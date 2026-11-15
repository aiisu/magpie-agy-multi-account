import { test, expect } from 'bun:test'
import { Turn } from '../index.mjs'

const prefix = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits.'
const warning = '\n' + prefix + ' Resets in 131h12m36s.'

function run(chunks) {
  const turn = new Turn({}, [{ role: 'user', content: 'Hello' }])
  for (const chunk of chunks) turn.pushText(chunk)
  turn.endText()
  turn.flushText()
  return turn
}

test('withholds and classifies the quota warning across every chunk boundary', () => {
  for (let boundary = 1; boundary < warning.length; boundary++) {
    const turn = run([warning.slice(0, boundary), warning.slice(boundary)])
    expect(turn.agentError).toBe(true)
    expect(turn.agentErrorCore).toBe(warning.trim())
    expect(turn.events).toEqual([])
  }
  const turn = run([...warning])
  expect(turn.agentError).toBe(true)
  expect(turn.events).toEqual([])
})

test('handles different reset durations and an omitted reset', () => {
  for (const tail of ['', ' Resets in 5h.', ' Resets in 10m2s.', ' Resets in 9s', ' Resets in 0h0m0s.\n']) {
    expect(run(['\n' + prefix + tail]).agentError).toBe(true)
  }
})

test('keeps ordinary explanations and quoted warnings followed by text', () => {
  for (const text of ['Individual quota reached means a limit was hit.',
    warning + '\nThis is an example from the documentation.',
    warning + ' This is a quoted warning.', '\n' + prefix + ' Resets in unknown.']) {
    const turn = run([...text])
    expect(turn.agentError).toBe(false)
    expect(turn.events.map(event => event.text || '').join('')).toBe(text)
  }
})

test('preserves preceding model text while withholding the warning', () => {
  const turn = run(['A partial explanation.', warning])
  expect(turn.agentError).toBe(true)
  expect(turn.events.map(event => event.text || '').join('')).toBe('A partial explanation.')
})
