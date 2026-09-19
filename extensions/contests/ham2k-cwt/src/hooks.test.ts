// Copyright © 2026 Robert Jackson, N1RWJ
// SPDX-License-Identifier: MIT

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hooks, host } from '@ham2k/extension-sdk'
import type { ExportResult, JSONValue, LoggingControlDescriptor } from '@ham2k/extension-sdk'
import { fixtureOperation, fixtureQso, loadExtension } from './sdkGapTesting.ts'

type Qson = Record<string, JSONValue>
type AdifField = { name: string; value: string }

const cwt = await loadExtension(() => import('./index.ts'), {
  hostCalls: { fetch: () => { throw new Error('Logging must not fetch call-history data') } },
})
const operation = fixtureOperation({
  refs: [{ type: 'cwt', ref: '2026-09-16-1300', ourName: 'Seb', ourNumber: '1234', power: 'LP' }],
})
const snapshot = await cwt.runHook('dataFile', 'rawToJSONData', {
  body: '!!Order!!,Call,Name,Exch1\n# CWOPS\nK1ABC,Al,4567\nK2ABC,Bob,CWA\nK3ABC,Carl,PA\n',
  url: 'https://n1mmwp.hamdocs.com/mmfile/get/file/CWOPS_TEST.txt',
})
// Clear runtime state before replaying the snapshot, as on a later app launch.
await cwt.runHook('dataFile', 'onRemoveRawData')
await cwt.runHook('dataFile', 'onLoadRawData', snapshot)

function qso(call: string): Qson {
  return fixtureQso({
    uuid: `new-${call}`, their: { call, sent: '599' }, our: { call: 'KI2D', sent: '599' },
    mode: 'CW', freq: 14030, startAtMillis: Date.UTC(2026, 8, 16, 13, 5),
  })
}

function object(value: JSONValue | undefined): Qson {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

async function save(draft: Qson): Promise<Qson> {
  const patch = await cwt.runHook('activity', 'processQsoBeforeSave', { operation, qso: draft }) as Qson | null
  return { ...draft, ...patch, their: { ...object(draft.their), ...object(patch?.their) } }
}

async function adifFields(saved: Qson): Promise<AdifField[]> {
  return await cwt.runHook('adifFields', 'fieldsForOneQSO', { operation, qso: saved }) as AdifField[]
}

async function cabrillo(saved: Qson): Promise<ExportResult> {
  return await cwt.runHook('export', 'generateExport', {
    operation, qsos: [saved], exportType: 'cwt-cabrillo',
  }) as ExportResult
}

for (const [call, name, number] of [
  ['K1ABC', 'AL', '4567'], ['K2ABC', 'BOB', 'CWA'], ['K3ABC', 'CARL', 'PA'],
  ['W9ZZZ', 'HELMUT', 'WI'], ['DL1ABC', 'HELMUT', 'DL'],
]) {
  test(`${call}: cached data → suggested controls → saved exchange → ADIF and Cabrillo`, async () => {
    const draft = qso(call)
    draft.their = { ...object(draft.their), guess: { name: 'Helmut', ...(call === 'DL1ABC' ? {} : { state: 'wi' }) } }
    const controls = await cwt.runHook('activity', 'loggingControls', {
      operation, qso: draft,
    }) as LoggingControlDescriptor[]
    // The host stores accepted suggestions on the CWT ref. Native touched-field
    // behavior belongs to the app; this test checks the extension's boundaries.
    const accepted: Qson = { type: 'cwt' }
    for (const { input } of controls) {
      if (input.kind === 'text') accepted[input.field] = input.suggestedValue?.trim() ?? ''
    }
    assert.deepEqual(accepted, { type: 'cwt', name, number })
    const saved = await save({ ...draft, refs: [accepted] })
    assert.equal(object(saved.their).exchange, `${name} ${number}`)
    assert.deepEqual(await adifFields(saved), [
      { name: 'CONTEST_ID', value: 'CWOPS-CWT' },
      { name: 'STX_STRING', value: 'SEB 1234' },
      { name: 'SRX_STRING', value: `${name} ${number}` },
    ])
    const exported = await cabrillo(saved)
    assert.match(exported.content, /CONTEST: CWOPS-CWT\n/)
    assert.match(exported.content, /CATEGORY-POWER: LOW\n/)
    assert.ok(exported.content.includes(`QSO: 14030 CW 2026-09-16 1305 KI2D 599 SEB 1234 ${call} 599 ${name} ${number}\n`))
    assert.ok(exported.filename.includes('CWT-2026-09-16-1300'))
  })
}

test('operator corrections and deliberate blanks take precedence on save and export', async () => {
  for (const name of ['allen', '']) {
    const saved = await save({
      ...qso('K1ABC'),
      their: { call: 'K1ABC', exchange: 'AL 4567', guess: { name: 'Al' } },
      refs: [{ type: 'cwt', name, number: '' }],
    })
    assert.deepEqual(saved.refs, [{ type: 'cwt', name: name.toUpperCase(), number: '' }])
    assert.equal(object(saved.their).exchange, name.toUpperCase())
    const received = (await adifFields(saved)).find((field) => field.name === 'SRX_STRING')
    assert.equal(received?.value, name ? 'ALLEN' : undefined)
    assert.ok((await cabrillo(saved)).content.includes(`K1ABC 599 ${name ? 'ALLEN' : '-'}\n`))
  }
})

test('manual exchange values, including clearing, survive the location fallback on save', async () => {
  for (const number of ['', '9999']) {
    const draft = {
      ...qso('W9ZZZ'),
      their: { call: 'W9ZZZ', guess: { state: 'WI' } },
      refs: [{ type: 'cwt', name: 'ROB', number }],
    }
    const controls = await cwt.runHook('activity', 'loggingControls', { operation, qso: draft }) as LoggingControlDescriptor[]
    const input = controls.find((control) => control.key === 'cwt/number')?.input
    assert.ok(input?.kind === 'text')
    assert.equal(input.suggestedValue, 'WI')
    // Native touched controls retain the operator value instead of applying
    // this suggestion. Verify the save hook does not guess over that value.
    const saved = await save(draft)
    assert.equal(object(saved.their).exchange, number ? 'ROB 9999' : 'ROB')
    assert.equal((await adifFields(saved)).find((field) => field.name === 'SRX_STRING')?.value, number ? 'ROB 9999' : 'ROB')
  }
})

test('ADIF delegates to the host using the official CWT handler', async (t) => {
  const invoke = t.mock.method(hooks, 'invokeOne', async () => [{
    key: 'adif', ok: true, value: { content: '<eoh>\n<eor>' },
  }])
  const result = await cwt.runHook('export', 'generateExport', {
    operation, qsos: [], exportType: 'cwt-adif',
  }) as ExportResult
  assert.equal(result.content, '<eoh>\n<eor>')
  assert.equal(invoke.mock.callCount(), 1)
  const [category, key, method, args] = invoke.mock.calls[0].arguments
  assert.deepEqual([category, key, method], ['export', 'adif', 'generateExport'])
  assert.partialDeepStrictEqual(args, { exportType: 'adif', mainHandler: 'ham2k-cwt' })
})

test('the registered prefill stays scoped to CWT and preserves scoring', async () => {
  assert.deepEqual(await cwt.runHook('activity', 'loggingControls', { operation: {}, qso: qso('K1ABC') }), [])
  assert.deepEqual(await cwt.runHook('lookup', 'lookupCall', {
    operation: {}, qso: {}, callInfo: { call: 'K1ABC' },
  }), [])
  const result = await cwt.runHook('scoring', 'scoreQsos', {
    operation,
    qsos: [qso('K1ABC'), qso('K2ABC'), { ...qso('K1ABC'), uuid: 'second-band', band: '40m' }],
  }) as { operationSummary: Record<string, { points: number; mults: number; total: number }> }
  assert.partialDeepStrictEqual(result.operationSummary.cwt, { points: 3, mults: 2, total: 6 })
})


test('CWT exposes a default call-history filter without fetching reports', async (t) => {
  const fetched = t.mock.method(host, 'fetch', async () => { throw new Error('No network expected') })
  for (const locale of ['en', 'es']) {
    const descriptor = await cwt.runHook('spotCallFilter:v1', 'describe', {}, { ctx: { locale } })
    assert.partialDeepStrictEqual(descriptor, { version: 1, available: true, defaultSelected: true })
    assert.ok(!JSON.stringify(descriptor).includes('{{'))
  }
  assert.deepEqual(await cwt.runHook('spotCallFilter:v1', 'matchCalls', {
    version: 1, calls: ['K1ABC/P', 'W9NEW'],
  }), { version: 1, available: true, calls: ['K1ABC/P'] })
  await cwt.runHook('dataFile', 'onRemoveRawData', {})
  assert.partialDeepStrictEqual(await cwt.runHook('spotCallFilter:v1', 'matchCalls', {
    version: 1, calls: ['K1ABC'],
  }), { available: false, calls: [] })
  t.mock.method(host, 'getSettings', async () => ({ extensions: { 'extension_ham2k-cwt': { spotsHistoryOnly: false } } }))
  assert.partialDeepStrictEqual(await cwt.runHook('spotCallFilter:v1', 'describe', {}), { defaultSelected: false })
  assert.equal(fetched.mock.callCount(), 0)
})
