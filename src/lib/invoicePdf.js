import { jsPDF } from 'jspdf'
import { toCanvas } from 'html-to-image'

// Monthly invoice draft (díjbekérő / proforma) for one customer or store, as an A4 PDF.
// Not a tax invoice: the real invoice will come from szamlazz.hu later. Always in Hungarian.
// The page is laid out as HTML (so accents like ő/ű render with the app font) and rasterised into the PDF.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const n = (v, d = 2) => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: d }).format(Number(v || 0))
const ft = v => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 }).format(Math.round(Number(v || 0))) + ' Ft'
const d = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit' }) : ''

// lines: [{ product, unit, qty, unit_price }] (already grouped); deliveries: [{ date, no, items: 'Ramen 10 kg, …' }]
export function invoiceHtml({ seller, buyer, number, issueDate, periodFrom, periodTo, dueDate, vatRate, lines, deliveries, note }) {
  const vat = Number(vatRate) || 0
  const rows = lines.map(l => {
    const net = l.qty * l.unit_price
    return { ...l, net, vatAmt: net * vat / 100, gross: net * (1 + vat / 100) }
  })
  const tot = rows.reduce((a, r) => ({ qty: a.qty + r.qty, net: a.net + r.net, vat: a.vat + r.vatAmt, gross: a.gross + r.gross }), { qty: 0, net: 0, vat: 0, gross: 0 })
  const party = (title, p) => `
    <div class="inv-party"><div class="inv-label">${title}</div>
      <b>${esc(p.name)}</b>${p.store ? `<div>${esc(p.store)}</div>` : ''}
      <div>${esc(p.address || '')}</div>
      ${p.tax_no ? `<div>Adószám: ${esc(p.tax_no)}</div>` : ''}
      ${p.reg_no ? `<div>Cégjegyzékszám: ${esc(p.reg_no)}</div>` : ''}
      ${p.bank ? `<div>Bankszámla: ${esc(p.bank)}</div>` : ''}
      ${p.email || p.phone ? `<div>${esc([p.email, p.phone].filter(Boolean).join(' · '))}</div>` : ''}
    </div>`
  return `
  <div class="inv">
    <div class="inv-head">
      <div><div class="inv-title">DÍJBEKÉRŐ</div><div class="inv-sub">Proforma · nem számla</div></div>
      <table class="inv-meta">
        <tr><td>Sorszám</td><td><b>${esc(number)}</b></td></tr>
        <tr><td>Kelt</td><td>${d(issueDate)}</td></tr>
        <tr><td>Teljesítési időszak</td><td>${d(periodFrom)} – ${d(periodTo)}</td></tr>
        <tr><td>Fizetési határidő</td><td>${d(dueDate)}</td></tr>
        <tr><td>Fizetési mód</td><td>átutalás</td></tr>
      </table>
    </div>
    <div class="inv-parties">${party('Eladó', seller)}${party('Vevő', buyer)}</div>
    <table class="inv-lines">
      <thead><tr><th>Megnevezés</th><th>Mennyiség</th><th>Nettó egységár</th><th>Nettó érték</th><th>ÁFA</th><th>ÁFA érték</th><th>Bruttó érték</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.product)}</td><td>${n(r.qty, 3)} ${esc(r.unit || 'kg')}</td><td>${ft(r.unit_price)}</td><td>${ft(r.net)}</td>
        <td>${vatRate === '' || vatRate == null ? '–' : n(vat, 1) + '%'}</td><td>${ft(r.vatAmt)}</td><td>${ft(r.gross)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Összesen</td><td>${n(tot.qty, 3)} kg</td><td></td><td>${ft(tot.net)}</td><td></td><td>${ft(tot.vat)}</td><td>${ft(tot.gross)}</td></tr></tfoot>
    </table>
    <div class="inv-total">Fizetendő: <b>${ft(tot.gross)}</b></div>
    ${note ? `<p class="inv-note">${esc(note)}</p>` : ''}
    ${deliveries.length ? `<div class="inv-label inv-dl">Szállítások a teljesítési időszakban (${deliveries.length})</div>
      <table class="inv-deliv"><thead><tr><th>Dátum</th><th>Rendelés</th><th>Tételek</th></tr></thead>
      <tbody>${deliveries.map(x => `<tr><td>${d(x.date)}</td><td>#${esc(x.no)}</td><td>${esc(x.items)}</td></tr>`).join('')}</tbody></table>` : ''}
    <p class="inv-foot">Ez a dokumentum díjbekérő, nem minősül számlának. A számlát a szamlazz.hu rendszerből állítjuk ki.</p>
  </div>`
}

// A4 PDF: the HTML is laid out 794 px wide (A4 at 96 dpi) and sliced into pages
export async function invoicePdfBlob(html) {
  const host = document.createElement('div')
  host.className = 'inv-host'
  host.innerHTML = html
  document.body.appendChild(host)
  try {
    if (document.fonts?.ready) await document.fonts.ready
    const el = host.firstElementChild
    const canvas = await toCanvas(el, { pixelRatio: 2, backgroundColor: '#ffffff' })
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
    const pageW = 210, pageH = 297
    const pxPerMm = canvas.width / pageW
    const pagePx = Math.floor(pageH * pxPerMm)
    for (let y = 0, i = 0; y < canvas.height; y += pagePx, i++) {
      const h = Math.min(pagePx, canvas.height - y)
      if (i && h < pagePx * 0.03) break                // only a sliver of white page left
      const part = document.createElement('canvas')
      part.width = canvas.width; part.height = h
      part.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h)
      if (i) pdf.addPage('a4', 'portrait')
      pdf.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageW, h / pxPerMm, undefined, 'FAST')
    }
    return pdf.output('blob')
  } finally { host.remove() }
}
