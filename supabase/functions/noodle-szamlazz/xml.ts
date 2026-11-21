// Builds the Számla Agent request XML (xmlszamla) for one monthly invoice and parses szamlazz.hu answers.
// Pure functions (no I/O), so they can be tested without a szamlazz.hu account.
// Field order follows xmlszamla.xsd: the order is fixed by the schema.

export interface Party { name: string; address?: string | null; tax_no?: string | null; email?: string | null }
export interface Line { product: string; unit?: string | null; qty: number; unit_price: number }
export interface InvoiceInput {
  agentKey: string
  eInvoice: boolean             // e-számla (needs at least the #start package) or paper invoice
  sendEmail: boolean            // szamlazz.hu e-mails the invoice to the buyer
  issueDate: string             // YYYY-MM-DD
  fulfillmentDate: string
  dueDate: string
  vatRate: number               // e.g. 27, 18, 5, 0
  orderRef: string              // our reference (e.g. D-202611-CUSTOMER), shown on the invoice as order number
  comment?: string
  seller: { bank?: string | null; replyTo?: string | null }
  buyer: Party
  lines: Line[]
}

const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
const el = (name: string, v: unknown) => v === undefined || v === null || v === '' ? '' : `<${name}>${esc(v)}</${name}>`
const r2 = (n: number) => Math.round(n * 100) / 100

// "1118 Budapest, Késmárki utca 10." → { zip: '1118', city: 'Budapest', street: 'Késmárki utca 10.' }
export function splitAddress(a?: string | null) {
  const s = String(a ?? '').trim().replace(/\s+/g, ' ')
  let m = s.match(/^(?:H-?)?(\d{4})\s+([^,]+?),\s*(.+)$/i)
  if (m) return { zip: m[1], city: m[2].trim(), street: m[3].trim() }
  m = s.match(/^(.+?),\s*(?:H-?)?(\d{4})\s+([^,]+)$/i)      // "Késmárki utca 10., 1118 Budapest"
  if (m) return { zip: m[2], city: m[3].trim(), street: m[1].trim() }
  m = s.match(/^(?:H-?)?(\d{4})\s+(\S+)\s+(.+)$/i)           // "1118 Budapest Késmárki utca 10."
  if (m) return { zip: m[1], city: m[2].trim(), street: m[3].trim() }
  return null
}

// Hungarian tax number 12345678-1-23 (or 11 digits) → buyer is a Hungarian VAT subject
export const isHuTaxNo = (t?: string | null) => /^\d{8}-?\d-?\d{2}$/.test(String(t ?? '').trim())

// Per line: net = unit price × qty, VAT = net × rate, gross = net + VAT, all rounded to whole forints (HUF has no fillér).
export function lineAmounts(l: Line, vatRate: number) {
  const net = Math.round(l.qty * l.unit_price)
  const vat = Math.round(net * vatRate / 100)
  return { net, vat, gross: net + vat }
}

export function totals(lines: Line[], vatRate: number) {
  return lines.reduce((a, l) => { const x = lineAmounts(l, vatRate); return { net: a.net + x.net, vat: a.vat + x.vat, gross: a.gross + x.gross } },
    { net: 0, vat: 0, gross: 0 })
}

// what is missing before a real invoice can be issued (shown to the user, nothing is sent)
export function problems(inp: Omit<InvoiceInput, 'agentKey'>) {
  const p: string[] = []
  if (!inp.buyer.name?.trim()) p.push('buyer_name')
  if (!splitAddress(inp.buyer.address)) p.push('buyer_address')
  if (!inp.lines.length) p.push('no_lines')
  if (inp.lines.some(l => !(l.unit_price > 0))) p.push('no_price')
  if (inp.lines.some(l => !(l.qty > 0))) p.push('bad_qty')
  if (!(inp.vatRate >= 0 && inp.vatRate <= 27)) p.push('vat')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inp.dueDate) || !/^\d{4}-\d{2}-\d{2}$/.test(inp.fulfillmentDate)) p.push('dates')
  return p
}

export function invoiceXml(inp: InvoiceInput) {
  const a = splitAddress(inp.buyer.address) ?? { zip: '', city: '', street: String(inp.buyer.address ?? '') }
  const hu = isHuTaxNo(inp.buyer.tax_no)
  const items = inp.lines.map(l => {
    const x = lineAmounts(l, inp.vatRate)
    return '<tetel>' +
      el('megnevezes', l.product) + el('mennyiseg', Math.round(l.qty * 1000) / 1000) +
      el('mennyisegiEgyseg', l.unit || 'kg') + el('nettoEgysegar', r2(l.unit_price)) + el('afakulcs', inp.vatRate) +
      el('nettoErtek', x.net) + el('afaErtek', x.vat) + el('bruttoErtek', x.gross) +
      '</tetel>'
  }).join('')
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<xmlszamla xmlns="http://www.szamlazz.hu/xmlszamla" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.szamlazz.hu/xmlszamla https://www.szamlazz.hu/szamla/docs/xsds/agent/xmlszamla.xsd">' +
    '<beallitasok>' +
      el('szamlaagentkulcs', inp.agentKey) +
      el('eszamla', inp.eInvoice) +
      el('szamlaLetoltes', true) +          // send the PDF back, we keep a copy
      el('valaszVerzio', 1) +               // 1: answer body is the PDF, data in szlahu_* headers
    '</beallitasok>' +
    '<fejlec>' +
      el('keltDatum', inp.issueDate) + el('teljesitesDatum', inp.fulfillmentDate) + el('fizetesiHataridoDatum', inp.dueDate) +
      el('fizmod', 'Átutalás') + el('penznem', 'HUF') + el('szamlaNyelve', 'hu') + el('megjegyzes', inp.comment) +
      el('rendelesSzam', inp.orderRef) +
    '</fejlec>' +
    '<elado>' + el('bankszamlaszam', inp.seller.bank) + el('emailReplyto', inp.seller.replyTo) + '</elado>' +
    '<vevo>' +
      el('nev', inp.buyer.name) + el('irsz', a.zip) + el('telepules', a.city) + el('cim', a.street) +
      el('email', inp.buyer.email) + el('sendEmail', !!(inp.sendEmail && inp.buyer.email)) +
      el('adoalany', hu ? 1 : 0) + (hu ? el('adoszam', String(inp.buyer.tax_no).trim()) : '') +
    '</vevo>' +
    '<tetelek>' + items + '</tetelek>' +
    '</xmlszamla>'
}

// szamlazz.hu sends errors in headers, URL-encoded with '+' for spaces
export function agentError(h: Headers) {
  const code = h.get('szlahu_error_code')
  if (!code) return null
  let msg = h.get('szlahu_error') || ''
  try { msg = decodeURIComponent(msg.replace(/\+/g, ' ')) } catch { /* keep raw */ }
  return { code, message: msg }
}
