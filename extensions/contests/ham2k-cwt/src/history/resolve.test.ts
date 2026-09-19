// Copyright ©️ 2026 Robert Jackson (N1RWJ)
// SPDX-License-Identifier: MIT

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { CwtHistoryContact } from './index.ts'
import { baseCall, callLookupKeys, parseCallHistory, resolveCwtExchange } from './index.ts'

function contact(fields: Partial<CwtHistoryContact> = {}): CwtHistoryContact {
  return {
    call: 'K1ABC',
    contest: 'CWOPS',
    name: 'History',
    number: '123',
    timestamp: 100,
    ...fields,
  }
}

function file(text = 'K1ABC,File,456') {
  return parseCallHistory(`!!Order!!,Call,Name,Exch1\n${text}`).records
}

describe('field-aware CWT exchange resolution', () => {
  test('uses operator > current operation > selected file > older compatible history independently', () => {
    const olderHistory = Object.freeze([Object.freeze(contact({ name: 'Older', number: 'CWA' }))])
    const input = {
      call: ' k1abc ',
      currentOperation: [contact({ name: 'Current', number: undefined })],
      selectedFile: file(),
      olderHistory,
    }
    const result = resolveCwtExchange({
      ...input, operator: { call: 'k1abc', name: ' Correction ' },
    })
    assert.partialDeepStrictEqual(result.name, { value: ' Correction ', source: 'operator' })
    assert.partialDeepStrictEqual(result.number, { value: '456', source: 'selected-file' })
    assert.equal(result.membership, 'member')

    const fallback = resolveCwtExchange({ ...input, selectedFile: file('K1ABC,File,') })
    assert.partialDeepStrictEqual(fallback.name, { value: 'Current', source: 'current-operation' })
    assert.partialDeepStrictEqual(fallback.number, { value: 'CWA', source: 'older-history' })
    assert.equal(fallback.membership, 'cwa')
    assert.equal(olderHistory[0].name, 'Older')
  })

  test('treats an operator empty string or null as deliberate clearing', () => {
    const result = resolveCwtExchange({
      call: 'K1ABC',
      operator: { call: 'K1ABC', name: '', number: null },
      selectedFile: file(),
    })
    assert.partialDeepStrictEqual(result.name, { value: '', source: 'operator' })
    assert.partialDeepStrictEqual(result.number, { value: '', source: 'operator' })
    assert.equal(result.membership, 'unknown')
  })

  test('does not carry an edit or clearing to a different call', () => {
    const result = resolveCwtExchange({
      call: 'W1XYZ',
      operator: { call: 'K1ABC', name: 'Wrong', number: '' },
      selectedFile: file('W1XYZ,Lee,CWA'),
    })
    assert.equal(result.name?.value, 'Lee')
    assert.equal(result.number?.value, 'CWA')
  })

  test('uses the newest available fields, sorts undated rows last, and breaks ties stably', () => {
    const olderHistory = [
      contact({ name: 'Undated', number: '999', timestamp: undefined }),
      contact({ name: 'Old', number: 'MA', timestamp: 100 }),
      contact({ name: 'New', number: '', timestamp: 300 }),
      contact({ name: '', number: '987', timestamp: 200 }),
    ]
    for (const history of [olderHistory, [...olderHistory].reverse()]) {
      const result = resolveCwtExchange({ call: 'K1ABC', olderHistory: history })
      assert.equal(result.name?.value, 'New')
      assert.equal(result.number?.value, '987')
    }
    const tied = resolveCwtExchange({
      call: 'K1ABC',
      olderHistory: [contact({ name: 'First' }), contact({ name: 'Second' })],
    })
    assert.equal(tied.name?.value, 'First')
  })

  test('missing exchanges stay unknown despite unrelated, unmarked, or other-call history', () => {
    const olderHistory = [
      contact({ contest: 'NAQPCW' }), contact({ contest: '' }),
      contact({ contest: 'CWOPEN' }), contact({ call: 'K2XYZ' }),
    ]
    for (const selectedFile of [file('W1XYZ,Lee,NY'), file('K1ABC,Pat,')]) {
      const result = resolveCwtExchange({ call: 'K1ABC', selectedFile, olderHistory })
      assert.equal(result.number, undefined)
      assert.equal(result.membership, 'unknown')
      assert.equal(result.name?.value, selectedFile.K1ABC?.name)
    }
  })

  test('prefers exact portable entries over base entries, field by field', () => {
    const result = resolveCwtExchange({
      call: 'N0AC/M',
      selectedFile: file('N0AC,Bill,1252\nN0AC/M,,IA'),
    })
    assert.partialDeepStrictEqual(result.name, { value: 'Bill', match: 'base' })
    assert.partialDeepStrictEqual(result.number, { value: 'IA', matchedCall: 'N0AC/M', match: 'exact' })
    assert.equal(result.membership, 'nonmember')
  })

  test('prefers exact history matches over newer base matches within a source', () => {
    const result = resolveCwtExchange({
      call: 'K1ABC/P',
      olderHistory: [
        contact({ name: 'Base', timestamp: 300 }),
        contact({ call: 'K1ABC/P', name: 'Portable', timestamp: 100 }),
      ],
    })
    assert.equal(result.name?.value, 'Portable')
  })

  test('rejects base-call locations for portable calls but accepts an older exact location', () => {
    for (const call of ['VE3/K1ABC', 'K1ABC/P']) {
      const input = {
        call,
        selectedFile: file('K1ABC,Pat,CA'),
        currentOperation: [contact({ number: 'TX' })],
        olderHistory: [contact({ number: 'MA' })],
      }
      const result = resolveCwtExchange(input)
      assert.equal(result.name?.value, 'History')
      assert.equal(result.number, undefined)
      assert.equal(result.membership, 'unknown')
      const exact = resolveCwtExchange({
        ...input, olderHistory: [contact({ call, number: 'ON' })],
      })
      assert.partialDeepStrictEqual(exact.number, { value: 'ON', source: 'older-history', match: 'exact' })
    }
  })

  test('keeps source precedence ahead of exact/base preference', () => {
    const result = resolveCwtExchange({
      call: 'K1ABC/P',
      currentOperation: [contact({ number: 'CWA' })],
      selectedFile: file('K1ABC/P,File,456'),
    })
    assert.partialDeepStrictEqual(result.number, {
      value: 'CWA', source: 'current-operation', match: 'base',
    })
  })
})

describe('callsign matching', () => {
  test('uses an unambiguous base call for portable prefixes and suffixes', () => {
    for (const call of ['K1ABC/P', 'K1ABC/M', 'K1ABC/QRP', 'K1ABC/4', 'EA8/K1ABC', 'EA8/K1ABC/P']) {
      assert.equal(baseCall(call), 'K1ABC', call)
      assert.deepEqual(callLookupKeys(call), [call, 'K1ABC'], call)
    }
  })

  test('does not substitute a portable record for a base call or choose between two full calls', () => {
    assert.deepEqual(callLookupKeys('K1ABC'), ['K1ABC'])
    assert.equal(baseCall('K1ABC/W2XYZ'), 'K1ABC/W2XYZ')
    assert.equal(
      resolveCwtExchange({ call: 'K1ABC', selectedFile: file('K1ABC/P,Pat,123') }).number,
      undefined,
    )
  })

  test('rejects incomplete and malformed calls', () => {
    for (const call of ['', 'K', '123', 'K1 A', 'K1ABC/', '<html>']) {
      assert.deepEqual(callLookupKeys(call), [], call)
    }
  })
})
