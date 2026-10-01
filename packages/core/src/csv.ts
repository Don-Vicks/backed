// CSV for spreadsheets. Dependency-free so the browser builds the maker's orders export with it.

// A spreadsheet treats a cell starting with = + - @ (or a tab or carriage return ahead of one) as a
// formula, so a backer could plant one in their shipping name. Such text gets a leading apostrophe,
// which spreadsheets read as "this is text" and do not show. Numbers are left alone.
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n')
}
