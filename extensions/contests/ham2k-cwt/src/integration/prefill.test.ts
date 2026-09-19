// Copyright ©️ 2026 Robert Jackson (N1RWJ)
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contestScorer } from '@ham2k/extension-sdk'
import type { ActivityHook, HookContext, JSONValue, LoggingControlDescriptor } from '@ham2k/extension-sdk'
import { createFileCache } from '../data/cache.ts'
import { guessedName, guessedQth } from '../exchange.ts'
import { CWTScorer } from '../scorer.ts'
import { cwtRef, object } from './history.ts'
import { createPrefill } from './prefill.ts'

type Qson = Record<string, JSONValue>
const operation: Qson = {
  stationCall: 'N1RWJ/TEST',
  createdAtMillis: 1789832158828,
  refs: [{ type: 'cwt', ref: '2026-09-23-1300' }],
}
const ctx: HookContext = { online: false, locale: 'en' }
const file = '!!Order!!,Call,Name,Exch1\n# CWOPS\nK1ABC,Al Bert,4567\nK2ABC,Bob,CWA\nK4ABC,Dan,\n'

// Minimal activity boundary; the registered-hook tests use the real CWT activity.
const baseActivity: ActivityHook = {
  async loggingControls({ operation, qso }) {
    if (!cwtRef(operation)) return []
    const their = object(qso?.their)
    return [
      {
        key: 'cwt/name', label: 'Name',
        input: { kind: 'text', refType: 'cwt', field: 'name', suggestedValue: guessedName(their) },
      },
      {
        key: 'cwt/number', label: 'Nr',
        input: { kind: 'text', refType: 'cwt', field: 'number', placeholder: guessedQth(their) },
      },
    ]
  },
}

async function setup(base = baseActivity) {
  const cache = createFileCache({ read: async () => null, write: async () => {} })
  await cache.replace({ schema: 1, body: file, url: 'file.txt', fetchedAt: '2026-09-19T15:00:00.000Z' })
  return createPrefill(cache, base)
}

function textInput(controls: LoggingControlDescriptor[], field: string) {
  const input = controls.find((control) => control.input.kind === 'text' && control.input.field === field)?.input
  assert.ok(input?.kind === 'text')
  return input
}

test('scoring connects UUID-less controls to current history, with per-field fallback and localized provenance', async () => {
  const prefill = await setup()
  const saved: Qson = {
    uuid: 'saved-contact', their: { call: 'K1ABC' },
    refs: [{ type: 'cwt', number: '9876' }],
    band: '20m', mode: 'CW', startAtMillis: 1789832362350,
  }
  const older: Qson = {
    uuid: 'older-contact', their: { call: 'K1ABC' },
    refs: [{ type: 'cwt', name: 'OLD', number: '1111' }],
  }
  await prefill.scoring(contestScorer(CWTScorer, { scope: { refTypes: ['cwt'] } })).scoreQsos(
    { operation: { ...operation, uuid: 'native-operation' }, qsos: [saved] }, ctx,
  )
  const context: HookContext = {
    ...ctx,
    getHistoryForCall: async () => [saved, older],
  }
  const controls = await prefill.activity.loggingControls(
    { operation, qso: { their: { call: 'K1ABC' } } }, context,
  )
  assert.equal(textInput(controls, 'name').suggestedValue, 'AL', 'file name is normalized to its first word')
  assert.equal(textInput(controls, 'number').suggestedValue, '9876', 'current correction overrides the file')
  const results = await prefill.lookup.lookupCall(
    { operation, qso: {}, callInfo: { call: 'K1ABC' } }, { ...context, locale: 'es' },
  )
  assert.equal(results[0]?.source, 'ham2k-cwt')
  const note = String(results[0]?.notes?.[0] ?? '')
  assert.match(note, /nombre Al Bert \(archivo seleccionado\); intercambio 9876 \(operación actual\)/)
  assert.match(note, /archivo fecha desconocida, descargado 2026-09-19/)
})

test('unknown exchanges replace stale suggestions with a location fallback and retain name fallback', async () => {
  const { activity } = await setup()
  for (const [call, name] of [['K4ABC', 'DAN'], ['W9ZZZ', 'HIRAM']]) {
    const controls = await activity.loggingControls({
      operation,
      qso: {
        their: { call, guess: { name: 'Hiram Percy', state: 'WI' } },
        refs: [{ type: 'cwt', name: 'STALE', number: '4567' }],
      },
    }, ctx)
    assert.equal(textInput(controls, 'name').suggestedValue, name)
    assert.equal(textInput(controls, 'number').placeholder, 'WI')
    assert.equal(textInput(controls, 'number').suggestedValue, 'WI')
  }
})

test('location fallback uses state, entity prefix, then country file, and clears when unavailable', async () => {
  const { activity } = await setup()
  for (const [their, expected] of [
    [{ call: 'DL1ABC', state: 'be', guess: { state: 'by' }, entityPrefix: 'DL' }, 'BE'],
    [{ call: 'DL1ABC', entityPrefix: 'oe' }, 'OE'],
    [{ call: 'DL1ABC', guess: { entityPrefix: 'oe' } }, 'OE'],
    [{ call: 'DL1ABC' }, 'DL'],
    [{ call: '' }, ' '],
    [{ call: 'W9ZZZ', state: '1234' }, ' '],
    [{ call: 'W9ZZZ', state: 'CWA' }, ' '],
    [{ call: 'W9ZZZ', state: 'TOO-LONG' }, ' '],
  ] as [Qson, string][]) {
    const controls = await activity.loggingControls({ operation, qso: { their } }, ctx)
    assert.equal(textInput(controls, 'number').suggestedValue, expected)
  }
})

test('file and older CWT exchanges both take priority over location guesses', async () => {
  const { activity } = await setup()
  for (const [call, expected] of [['K1ABC', '4567'], ['K2ABC', 'CWA'], ['K4ABC', '6789']]) {
    const controls = await activity.loggingControls(
      { operation, qso: { their: { call, guess: { state: 'WI' } } } },
      { ...ctx, getHistoryForCall: async () => [{
        uuid: 'old', their: { call }, refs: [{ type: 'cwt', number: '6789' }],
      }] },
    )
    assert.equal(textInput(controls, 'number').suggestedValue, expected)
  }
})

test('concurrent callsign answers remain scoped to their request', async () => {
  const prefill = await setup()
  let finish!: (value: Qson[]) => void
  const pending = new Promise<Qson[]>((resolve) => { finish = resolve })
  const context = {
    ...ctx,
    getHistoryForCall: (call: string) => call === 'K1ABC' ? pending : Promise.resolve([]),
  }
  const first = prefill.activity.loggingControls(
    { operation, qso: { their: { call: 'K1ABC' } } }, context,
  )
  const second = await prefill.activity.loggingControls(
    { operation, qso: { their: { call: 'K2ABC' } } }, context,
  )
  finish([])
  assert.equal(textInput(await first, 'number').suggestedValue, '4567')
  assert.equal(textInput(second, 'number').suggestedValue, 'CWA')
})

test('wrapping preserves other activity methods and unrelated controls', async () => {
  const saving: NonNullable<ActivityHook['processQsoBeforeSave']> = async () => null
  const unrelated: LoggingControlDescriptor = {
    key: 'other', label: 'Other',
    input: { kind: 'text', refType: 'other', field: 'name', suggestedValue: 'KEEP' },
  }
  const { activity } = await setup({
    processQsoBeforeSave: saving,
    loggingControls: async () => [unrelated],
  })
  assert.equal(activity.processQsoBeforeSave, saving)
  assert.deepEqual(await activity.loggingControls({ operation }, ctx), [unrelated])
  assert.deepEqual(await (await setup({})).activity.loggingControls({ operation }, ctx), [])
})
