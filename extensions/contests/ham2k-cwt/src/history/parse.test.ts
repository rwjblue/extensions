// Copyright ©️ 2026 Robert Jackson (N1RWJ)
// SPDX-License-Identifier: MIT

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCallHistory } from './parse.ts'

describe('N1MM call history', () => {
  test('parses the actual CWOPS file structure and explicit exchange categories', () => {
    // Representative records from CWOPS_3992-AAA.txt, retrieved 2026-09-19.
    const parsed = parseCallHistory(`!!Order!!,Call,Name,Exch1,UserText,
# CWOPS
# LastEdit,2026-09-17
2E0DCW,Gerald,,London England
2E0IER,Brian,3702,Doncaster England
AA0AI,Steve,IA,North Liberty IA
AA4NO,Bill,CWA,Wilmington NC
9A/S57KM,Sandi,9A,
KE6K,John,1427,Welch,K,AZ,
`)
    assert.equal(parsed.usable, true)
    assert.deepEqual(parsed.associations, ['CWOPS'])
    assert.equal(parsed.sourceUpdatedAt, '2026-09-17')
    assert.deepEqual(parsed.records['2E0IER'], {
      call: '2E0IER', name: 'Brian', number: '3702', membership: 'member',
    })
    assert.partialDeepStrictEqual(parsed.records.AA0AI, { number: 'IA', membership: 'nonmember' })
    assert.partialDeepStrictEqual(parsed.records.AA4NO, { number: 'CWA', membership: 'cwa' })
    assert.partialDeepStrictEqual(parsed.records['9A/S57KM'], { number: '9A', membership: 'nonmember' })
    assert.deepEqual(parsed.records['2E0DCW'], {
      call: '2E0DCW', name: 'Gerald', membership: 'unknown',
    })
    assert.partialDeepStrictEqual(parsed.records.KE6K, { name: 'John', number: '1427' })
    assert.deepEqual(parsed.issues.map(({ code, severity }) => ({ code, severity })), [
      { code: 'extra-columns', severity: 'warning' },
    ])
  })

  test('handles reordered columns, quoting, and delimiter changes with BOM and CRLF', () => {
    const parsed = parseCallHistory(
      '\uFEFF!!Order!!; Exch1;CALL; Name;;State\r\n# cwoPS\r\n\r\n' +
      ' 122 ; k1abc/p ; "Pat; ""PJ""" ; ignored ; MA\r\n ; W1XYZ ; ; ; PA\r\n' +
      '!!Order!!,Call,Name,Exch1\r\nK2ABC,"Lee, Jr.",CWA',
    )
    assert.equal(parsed.usable, true)
    assert.deepEqual(parsed.records['K1ABC/P'], {
      call: 'K1ABC/P', name: 'Pat; "PJ"', number: '122', membership: 'member',
    })
    assert.deepEqual(parsed.records.W1XYZ, { call: 'W1XYZ', membership: 'unknown' })
    assert.partialDeepStrictEqual(parsed.records.K2ABC, { name: 'Lee, Jr.', number: 'CWA' })
    assert.deepEqual(parsed.issues, [])
  })

  test('uses default columns and ignores ordinary comments and invalid dates', () => {
    const parsed = parseCallHistory(
      '# Thanks K1ABC\n# Notes\n# LastEdit,2026-02-31\nK1ABC,Pat,,,,MA,,,1234\nW1XYZ,Lee,,,,TX',
    )
    assert.partialDeepStrictEqual(parsed.records.K1ABC, { name: 'Pat', number: '1234' })
    assert.deepEqual(parsed.records.W1XYZ, { call: 'W1XYZ', name: 'Lee', membership: 'unknown' })
    assert.deepEqual(parsed.associations, [])
    assert.equal(parsed.sourceUpdatedAt, undefined)
    assert.equal(parsed.usable, true)
  })

  test('ignores unknown columns with an actionable warning', () => {
    const parsed = parseCallHistory('!!Order!!,Call,Name,Number\nK1ABC,Pat,123')
    assert.equal(parsed.usable, true)
    assert.equal(parsed.records.K1ABC?.number, undefined)
    assert.equal(parsed.issues[0]?.code, 'unknown-column')
  })

  test('reads spaced and numbered source dates without accepting invalid calendar dates', () => {
    for (const comment of ['LastEdit', 'Last Edit', '1-Last Edit', '2 - Last Edit']) {
      const parsed = parseCallHistory(`# ${comment},2026-09-15\nK1ABC,Pat`)
      assert.equal(parsed.sourceUpdatedAt, '2026-09-15', comment)
      assert.equal(parsed.usable, true, comment)
      assert.equal(parseCallHistory(`# ${comment},2026-02-31\nK1ABC,Pat`).sourceUpdatedAt, undefined, comment)
    }
  })

  test('rejects unsupported directives and ambiguous column orders', () => {
    for (const [directive, code] of [
      ['!!MapStateToSect!!', 'unsupported-directive'],
      ['!!UnknownFutureDirective!!', 'unsupported-directive'],
      ['!!Order!!,Name,Exch1', 'invalid-order'],
      ['!!Order!!,Call,Call', 'invalid-order'],
      ['!!Order!!,Call,Exch1,Exch1', 'invalid-order'],
    ]) {
      const parsed = parseCallHistory(`${directive}\nK1ABC,Pat,321`)
      assert.equal(parsed.usable, false, directive)
      assert.ok(parsed.issues.some((issue) => issue.code === code && issue.line === 1 && issue.severity === 'error'), directive)
    }
  })

  test('rejects unrelated contests and accepts files with multiple associations including CWT', () => {
    assert.equal(parseCallHistory('# naqpcw\nK1ABC,Pat').usable, false)
    const parsed = parseCallHistory('# CQWWCW\n# CWOPS\n# cwops\nK1ABC,Pat')
    assert.equal(parsed.usable, true)
    assert.deepEqual(parsed.associations, ['CQWWCW', 'CWOPS'])
    assert.equal(parseCallHistory('# QSOParty PA\nK1ABC,Pat').usable, false)
  })

  test('rejects actual MST and SST associations instead of treating their exchanges as CWT data', () => {
    // Headers from ICWC-MST-075.txt and K1USNSST-060.txt, retrieved 2026-09-20.
    for (const [contest, order, row] of [
      ['ICWC-MST', 'Call,Name,Misc,UserText,', 'K1ABC,Pat,DX,'],
      ['K1USNSST', 'Call,Name,Exch1,UserText', 'K1ABC,Pat,MA,'],
      ['K1USN-SST', 'Call,Name,Exch1,UserText', 'K1ABC,Pat,DX,'],
    ]) {
      const parsed = parseCallHistory(`!!Order!!,${order}\n# ${contest}\n${row}`)
      assert.deepEqual(parsed.associations, [contest])
      assert.equal(parsed.usable, false, contest)
      assert.ok(parsed.issues.some((issue) => issue.code === 'incompatible-contest'), contest)
    }
  })

  test('merges duplicate records field by field, with later nonblank values winning', () => {
    const parsed = parseCallHistory(
      '!!Order!!,Call,Name,Exch1\nK1ABC,Pat,123\nK1ABC,Patrick,\nK1ABC,,456',
    )
    assert.deepEqual(parsed.records.K1ABC, {
      call: 'K1ABC', name: 'Patrick', number: '456', membership: 'member',
    })
    assert.equal(parsed.issues.filter((issue) => issue.code === 'duplicate-call').length, 2)
  })

  test('skips malformed rows while retaining valid records and never promotes usertext', () => {
    const parsed = parseCallHistory(
      '!!Order!!,Call,Name,Exch1,UserText\nK1ABC,Pat,?,CWA\nnot a call,Lee,45\nW1XYZ,"Broken,123\nN1ABC,Jo,0,NY',
    )
    assert.equal(parsed.usable, true)
    assert.deepEqual(Object.keys(parsed.records), ['K1ABC', 'N1ABC'])
    assert.equal(parsed.records.K1ABC?.membership, 'unknown')
    assert.equal(parsed.records.N1ABC?.number, undefined)
    assert.equal(parsed.issues.filter((issue) => issue.code === 'invalid-row').length, 2)
  })

  test('rejects empty and HTML responses', () => {
    assert.equal(parseCallHistory('').usable, false)
    assert.equal(parseCallHistory('<!DOCTYPE html>\n<html>Access denied</html>').usable, false)
  })
})
