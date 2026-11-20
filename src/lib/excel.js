// Excel (.xlsx) download for report tables. exceljs is loaded only when a download is clicked.
// Cells that are numbers, or formatted numbers like "1 234,5 kg" / "12,500 Ft" / "4.3%", become real
// numbers in Excel (with the unit moved to the number format) so the accountant can sum them.
const UNIT = /\s*(kg|Ft|%|db|pcs|l|g)$/i

export function toNumber(v, lang) {
  if (typeof v === 'number') return { n: v }
  if (typeof v !== 'string') return null
  const s = v.trim(); const m = s.match(UNIT); const unit = m ? m[1] : ''
  let body = s.replace(UNIT, '').replace(/[\s  ]/g, '')
  if (!/^-?[\d.,]+$/.test(body)) return null
  if (lang === 'hu') body = body.replace(/\./g, '').replace(',', '.')   // 1.234,5 / 1 234,5
  else body = body.replace(/,/g, '')                                     // 1,234.5
  const n = Number(body)
  return Number.isFinite(n) ? { n, unit } : null
}

const FMT = { kg: '#,##0.###" kg"', Ft: '#,##0" Ft"', '%': '0.0"%"', '': '#,##0.###' }

export async function downloadXlsx(file, sheets, lang) {
  const { default: ExcelJS } = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  for (const sh of sheets) {
    const ws = wb.addWorksheet(String(sh.name).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31))
    if (sh.title) { ws.addRow([sh.title]).font = { bold: true, size: 13 }; ws.addRow([]) }
    const h = ws.addRow(sh.head); h.font = { bold: true }
    h.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F3' } } })
    for (const row of sh.rows) {
      const r = ws.addRow(row.map(v => { const x = toNumber(v, lang); return x ? x.n : (v ?? '') }))
      row.forEach((v, i) => { const x = toNumber(v, lang); if (x && typeof v === 'string') r.getCell(i + 1).numFmt = FMT[x.unit] || FMT[''] })
    }
    sh.head.forEach((_, i) => { ws.getColumn(i + 1).width = i ? 16 : 32 })
    ws.views = [{ state: 'frozen', ySplit: sh.title ? 3 : 1, xSplit: 1 }]
  }
  const buf = await wb.xlsx.writeBuffer()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  a.download = file.endsWith('.xlsx') ? file : `${file}.xlsx`; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
