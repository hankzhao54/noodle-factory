import { useState } from 'react'
import { db, q, todayISO, supabase } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtFt } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, BlurNum, errText } from '../components/ui'

// Cost analysis (Nov 2026). Only people in noodle.cost_viewers see this page (not every admin).
// Labour: hours × hourly wage from 101base (ShiftDesk, location "101 Pastafactory") via the edge function noodle-costs.
// Employer tax, rent and utilities are monthly amounts, spread over the period by calendar days (÷ 30).
// Output = finished batches' actual kg; materials = what production used × the material's current price.

const L = {
  title: ['成本分析', 'Costs', 'Költségek'],
  onlyYou: ['只有成本查看人能看到这一页', 'Only cost viewers can see this page', 'Ezt az oldalt csak a költség-betekintők látják'],
  today: ['今天', 'Today', 'Ma'], yesterday: ['昨天', 'Yesterday', 'Tegnap'],
  thisMonth: ['本月', 'This month', 'Ez a hónap'], lastMonth: ['上月', 'Last month', 'Előző hónap'],
  last7: ['最近 7 天', 'Last 7 days', 'Utolsó 7 nap'], last30: ['最近 30 天', 'Last 30 days', 'Utolsó 30 nap'],
  from: ['从', 'From', 'Ettől'], to: ['到', 'To', 'Eddig'],
  output: ['产量', 'Output', 'Gyártott mennyiség'], hours: ['工时', 'Labour hours', 'Munkaórák'],
  kgPerHour: ['每工时产量', 'kg per labour hour', 'kg / munkaóra'], costPerKg: ['每 kg 成本', 'Cost per kg', 'Költség / kg'],
  margin: ['毛利（按内部价）', 'Margin (internal price)', 'Árrés (belső áron)'],
  costTitle: ['成本', 'Cost', 'Költség'], item: ['项目', 'Item', 'Tétel'], amount: ['金额', 'Amount', 'Összeg'], perKg: ['每 kg', 'Per kg', 'Kg-onként'],
  labour: ['人工', 'Labour', 'Munkabér'], tax: ['雇主税', 'Employer tax', 'Munkáltatói járulék'],
  materials: ['原料', 'Materials', 'Alapanyag'], fixed: ['房租 + 水电', 'Rent + utilities', 'Bérleti díj + rezsi'], total: ['合计', 'Total', 'Összesen'],
  proRata: ['每月金额按 {d} 天 ÷ 30 折算', 'Monthly amounts × {d} days ÷ 30', 'Havi összeg × {d} nap ÷ 30'],
  people: ['人工明细（101base 打卡）', 'Labour by person (101base timecards)', 'Munkaórák személyenként (101base)'],
  person: ['人员', 'Person', 'Személy'], days: ['天数', 'Days', 'Napok'], wage: ['时薪', 'Hourly wage', 'Órabér'],
  openCards: ['有 {n} 张打卡还没下班，工时按 0 算', '{n} timecard(s) still open, counted as 0 h', '{n} lezáratlan időkártya, 0 órával számolva'],
  noWage: ['有人没有时薪（可能是月薪），人工少算了', 'Someone has no hourly wage (salaried?), labour is understated', 'Valakinek nincs órabére (havibéres?), a munkabér alulbecsült'],
  laborErr: ['101base 工时读取失败：', 'Could not read hours from 101base: ', 'Nem sikerült a munkaórákat betölteni: '],
  production: ['生产', 'Production', 'Gyártás'], product: ['产品', 'Product', 'Termék'], batches: ['锅数', 'Batches', 'Adag'],
  theo: ['理论 kg', 'Recipe kg', 'Elméleti kg'], actual: ['实际 kg', 'Actual kg', 'Tényleges kg'], loss: ['损耗', 'Loss', 'Veszteség'],
  unweighed: ['没称重', 'Not weighed', 'Nem mért'], unweighedNote: ['实际产量 = 理论产量的批次，多半没称重', 'Batches entered at exactly the recipe yield, most likely not weighed', 'Pontosan az elméleti mennyiséggel rögzített adagok, valószínűleg nem mérték'],
  matTitle: ['原料用量', 'Materials used', 'Felhasznált alapanyag'], used: ['用量', 'Used', 'Felhasználás'], price: ['单价', 'Price', 'Egységár'],
  noPrice: ['没单价', 'no price', 'nincs ár'],
  revenue: ['收入和毛利', 'Revenue and margin', 'Bevétel és árrés'], kg: ['kg', 'kg', 'kg'],
  internal: ['自家餐厅（按内部价）', 'Own restaurants (internal price)', 'Saját éttermek (belső áron)'],
  samples: ['样品（免费，0 Ft）', 'Samples (free, 0 Ft)', 'Minta (ingyenes, 0 Ft)'],
  external: ['外部客户（实际售价）', 'External customers (actual prices)', 'Külső vevők (tényleges ár)'],
  revTotal: ['收入合计', 'Revenue', 'Bevétel'], costTotal: ['成本合计', 'Cost', 'Költség'], profit: ['毛利', 'Margin', 'Árrés'],
  revNote: ['按送货日在这段时间内、已送达的订单算；产量和成本按生产完成时间算，两者可能对不齐', 'Delivered orders by delivery date; output and cost by production date, so the two can differ', 'Kiszállított rendelések a szállítási nap szerint; a gyártás és a költség a gyártás napja szerint, ezért eltérhetnek'],
  scenario: ['情景测算（每月）', 'Scenario (per month)', 'Forgatókönyv (havonta)'],
  hoursDay: ['每天工时', 'Hours per day', 'Napi munkaóra'], kgDay: ['每天产量 kg', 'kg per day', 'Napi kg'],
  workDays: ['每月工作天数', 'Working days per month', 'Havi munkanap'], avgWage: ['平均时薪', 'Average hourly wage', 'Átlagos órabér'],
  sellPrice: ['售价 Ft/kg', 'Price Ft/kg', 'Ár Ft/kg'], monthKg: ['每月产量', 'Output per month', 'Havi mennyiség'],
  monthMargin: ['每月毛利', 'Margin per month', 'Havi árrés'], marginKg: ['每 kg 毛利', 'Margin per kg', 'Árrés / kg'],
  settings: ['参数', 'Settings', 'Beállítások'],
  rent_month: ['房租 / 月', 'Rent / month', 'Bérleti díj / hó'], utilities_month: ['水电 / 月', 'Utilities / month', 'Rezsi / hó'],
  tax_per_person_month: ['雇主税 / 人 / 月', 'Employer tax / person / month', 'Járulék / fő / hó'], tax_people: ['交税人数', 'People (tax)', 'Fő (járulék)'],
  internal_price: ['内部价 Ft/kg', 'Internal price Ft/kg', 'Belső ár Ft/kg'], plan_kg_per_hour: ['计划效率 kg/工时', 'Planned kg per hour', 'Tervezett kg/óra'],
  work_days_month: ['每月工作天数', 'Working days / month', 'Munkanap / hó'],
  min_production_shift_h: ['做面打卡至少几小时', 'Min. hours of a production shift', 'Gyártási műszak min. óra'],
  otherWork: ['其他（打包 / 行政）', 'Other (packing / admin)', 'Egyéb (csomagolás / adminisztráció)'],
  prodHours: ['做面工时', 'Production hours', 'Gyártási órák'],
  shortNote: ['一次打卡不到 {h} 小时算其他工作（打包、行政），不算进效率；人工成本照样全部算', 'Timecards shorter than {h} h count as other work (packing, admin) and are left out of efficiency; labour cost still counts them', 'A {h} óránál rövidebb időkártyák egyéb munkának számítanak (csomagolás, adminisztráció), a hatékonyságba nem számítanak; a munkabérben benne vannak'],
  effTitle: ['每个人的效率', 'Efficiency per person', 'Hatékonyság személyenként'],
  effNote: ['每天的产量算在那天做面工时最多的人头上（只有一个人上班就是他），用当天产量 ÷ 他自己的做面工时', 'Each day\'s output counts for whoever had the most production hours that day (or the only one there): that day\'s output ÷ their own production hours', 'A napi mennyiség annak számít, akinek aznap a legtöbb gyártási órája volt (vagy aki egyedül dolgozott): napi mennyiség ÷ a saját gyártási órái'],
  kgh: ['kg/工时', 'kg/h', 'kg/óra'],
  madeDays: ['做面的日子', 'Days making noodles', 'Gyártási napok'], maker: ['做面的人', 'Made by', 'Gyártotta'],
  dayTitle: ['每天效率', 'Efficiency per day', 'Hatékonyság naponta'], date: ['日期', 'Date', 'Nap'], who: ['谁上班', 'Who worked', 'Ki dolgozott'],
  dayNote: ['产量按完成生产的时间算到当天；没打卡但有产量、或有打卡没产量的日子也列出来', 'Output counts on the day the batch was finished; days with output but no timecards, or hours but no output, are listed too', 'A mennyiség a gyártás befejezésének napjára számít; a csak órás vagy csak gyártásos napok is szerepelnek'],
  saved: ['已保存', 'Saved', 'Mentve'],
}
const LANGS = ['zh', 'en', 'hu']
const SETTING_KEYS = ['rent_month', 'utilities_month', 'tax_per_person_month', 'tax_people', 'internal_price', 'plan_kg_per_hour', 'work_days_month', 'min_production_shift_h']

const n = v => Number(v) || 0
const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5)
const monthStart = (iso = todayISO()) => iso.slice(0, 8) + '01'
function lastMonthRange() {
  const d = new Date(monthStart() + 'T12:00:00'); d.setDate(0)
  const end = d.toISOString().slice(0, 10)
  return [monthStart(end), end]
}

async function labour(from, to) {
  const { data, error } = await supabase.functions.invoke('noodle-costs', { body: { from, to } })
  if (error) {
    let e = { error: error.message }
    try { e = await error.context.json() } catch { /* not JSON */ }
    throw new Error(e.error || error.message)
  }
  return data.rows || []
}

export default function Costs() {
  const t = useT()
  const tr = (k, vars) => {
    let s = (L[k] || [k])[Math.max(0, LANGS.indexOf(t.lang))] ?? L[k][1]
    for (const [a, b] of Object.entries(vars || {})) s = s.replace(`{${a}}`, b)
    return s
  }
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(todayISO())
  const rep = useData(() => q(db.rpc('cost_report', { p_from: from, p_to: to })), [from, to])
  const lab = useData(() => labour(from, to), [from, to])

  const [lmFrom, lmTo] = lastMonthRange()
  const presets = [
    [tr('today'), todayISO(), todayISO()],
    [tr('yesterday'), todayISO(-1), todayISO(-1)],
    [tr('thisMonth'), monthStart(), todayISO()],
    [tr('lastMonth'), lmFrom, lmTo],
    [tr('last7'), todayISO(-6), todayISO()],
    [tr('last30'), todayISO(-29), todayISO()],
  ]
  const r = rep.data
  return (
    <div className="page">
      <PageHead title={`${tr('title')} 🔒`}>
        <label className="inline-field">{tr('from')} <input type="date" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} /></label>
        <label className="inline-field">{tr('to')} <input type="date" value={to} min={from} onChange={e => e.target.value && setTo(e.target.value)} /></label>
      </PageHead>
      <p className="muted small">{tr('onlyYou')}</p>
      <div className="date-chips">{presets.map(([label, f, tt]) => (
        <button key={label} type="button" className={from === f && to === tt ? 'chip on' : 'chip'} onClick={() => { setFrom(f); setTo(tt) }}>{label}</button>
      ))}</div>
      <ErrorBox error={rep.error} />
      {lab.error && <p className="note-box short-box">⚠ {tr('laborErr')}{lab.error.message}</p>}
      {!r ? !rep.error && <Loading /> : <Body r={r} rows={lab.data || []} labLoading={lab.loading} tr={tr} t={t} reload={rep.reload} />}
    </div>
  )
}

function Body({ r, rows, labLoading, tr, t, reload }) {
  const s = r.settings || {}
  const days = dayDiff(r.from, r.to) + 1
  const share = days / 30

  // labour by person
  const byPerson = {}
  for (const x of rows) {
    const p = byPerson[x.person] ||= { person: x.person, hours: 0, amount: 0, days: new Set(), wage: x.hourly_wage, open: 0 }
    p.hours += n(x.hours); p.amount += n(x.hours) * n(x.hourly_wage); p.days.add(x.day)
    if (x.open_card) p.open++
    if (x.hourly_wage != null) p.wage = x.hourly_wage
  }
  const people = Object.values(byPerson).sort((a, b) => b.hours - a.hours)
  const hours = people.reduce((a, p) => a + p.hours, 0)
  const labourFt = people.reduce((a, p) => a + p.amount, 0)
  const openCards = people.reduce((a, p) => a + p.open, 0)
  const noWage = rows.some(x => x.hourly_wage == null)

  const kg = r.production.reduce((a, x) => a + n(x.actual), 0)
  const taxFt = n(s.tax_per_person_month) * n(s.tax_people) * share
  const matFt = r.materials.reduce((a, x) => a + n(x.value), 0)
  const fixedFt = (n(s.rent_month) + n(s.utilities_month)) * share
  const totalFt = labourFt + taxFt + matFt + fixedFt
  const perKg = v => kg > 0 ? fmtFt(v / kg) : '–'

  const inter = r.deliveries.find(x => x.type === 'internal') || {}
  const ext = r.deliveries.filter(x => x.type !== 'internal' && x.type !== 'sample')
  const smpKg = n((r.deliveries.find(x => x.type === 'sample') || {}).kg)
  const intKg = n(inter.kg), intRev = intKg * n(s.internal_price)
  const extKg = ext.reduce((a, x) => a + n(x.kg), 0), extRev = ext.reduce((a, x) => a + n(x.value), 0)
  const revenue = intRev + extRev
  const kgh = hours > 0 ? kg / hours : null
  const avgWage = hours > 0 ? labourFt / hours : 3150

  return (<>
    <div className="kpi-grid">
      <Kpi label={tr('output')} value={`${fmtNum(Math.round(kg * 10) / 10, t.lang)} kg`} sub={`${r.from} – ${r.to}`} />
      <Kpi label={tr('hours')} value={labLoading ? '…' : `${fmtNum(Math.round(hours * 10) / 10, t.lang)} h`} />
      <Kpi label={tr('kgPerHour')} value={kgh == null ? '–' : fmtNum(Math.round(kgh * 10) / 10, t.lang)} />
      <Kpi label={tr('costPerKg')} value={perKg(totalFt)} />
      <Kpi label={tr('margin')} value={fmtFt(revenue - totalFt)} sub={kg > 0 ? `${tr('perKg')} ${fmtFt((revenue - totalFt) / Math.max(intKg + extKg + smpKg, 1))}` : ''} />
    </div>

    <Table title={tr('costTitle')} note={tr('proRata', { d: days })}
      head={[tr('item'), tr('amount'), tr('perKg')]}
      rows={[
        [tr('labour') + (hours ? ` (${fmtNum(Math.round(hours * 10) / 10, t.lang)} h)` : ''), fmtFt(labourFt), perKg(labourFt)],
        [tr('tax'), fmtFt(taxFt), perKg(taxFt)],
        [tr('materials'), fmtFt(matFt), perKg(matFt)],
        [tr('fixed'), fmtFt(fixedFt), perKg(fixedFt)],
      ]}
      foot={[tr('total'), fmtFt(totalFt), perKg(totalFt)]} />

    <Table title={tr('people')}
      note={[openCards ? tr('openCards', { n: openCards }) : '', noWage ? tr('noWage') : ''].filter(Boolean).join(' · ')}
      head={[tr('person'), tr('days'), tr('hours'), tr('wage'), tr('amount')]}
      rows={people.map(p => [p.person, p.days.size, fmtNum(Math.round(p.hours * 100) / 100, t.lang), p.wage != null ? fmtFt(p.wage) : '–', fmtFt(p.amount)])}
      foot={people.length > 1 ? [tr('total'), '', fmtNum(Math.round(hours * 100) / 100, t.lang), '', fmtFt(labourFt)] : null} />

    <Efficiency tr={tr} t={t} rows={rows} batches={r.batches || []} minH={s.min_production_shift_h ?? 2} />

    <Revenue tr={tr} t={t} rows={[
      [tr('internal'), intKg, intRev], [tr('external'), extKg, extRev],
      ...(smpKg ? [[tr('samples'), smpKg, 0]] : []),
    ]} revenue={revenue} cost={totalFt} note={tr('revNote')} />

    <Table title={tr('production')} note={r.production.some(x => n(x.unweighed)) ? tr('unweighedNote') : ''}
      head={[tr('product'), tr('batches'), tr('theo'), tr('actual'), tr('loss'), tr('unweighed')]}
      rows={r.production.map(x => [x.name, fmtNum(n(x.batches), t.lang), fmtNum(Math.round(n(x.theoretical) * 10) / 10, t.lang),
        fmtNum(Math.round(n(x.actual) * 10) / 10, t.lang),
        n(x.theoretical) ? `${fmtNum(Math.round((1 - n(x.actual) / n(x.theoretical)) * 1000) / 10, t.lang)}%` : '–',
        n(x.unweighed) || ''])} />

    <Table title={tr('matTitle')}
      head={[tr('materials'), tr('used'), tr('price'), tr('amount')]}
      rows={r.materials.map(x => [x.name, `${fmtNum(Math.round(n(x.used) * 1000) / 1000, t.lang)} ${x.unit || ''}`,
        x.price != null && n(x.price) ? fmtFt(x.price) : <span className="muted">{tr('noPrice')}</span>, fmtFt(x.value)])}
      foot={[tr('total'), '', '', fmtFt(matFt)]} />

    <Scenario tr={tr} t={t} s={s} avgWage={avgWage} matKg={kg > 0 ? matFt / kg : 186} />
    <Settings tr={tr} s={s} reload={reload} />
  </>)
}

const firstName = x => String(x || '').trim().split(/\s+/)[0].toLowerCase()
const r1 = v => Math.round(v * 10) / 10

function Efficiency({ tr, t, rows, batches, minH }) {
  // production hours per person per day (101base) and kg per day (noodle)
  // a timecard shorter than minH hours is other work (packing, admin): not production time
  const hrs = {}, names = {}, other = {}
  for (const x of rows) {
    const k = firstName(x.person); names[k] = x.person
    if (!(Number(x.hours) > 0)) continue // open or zero-length timecards
    if (Number(x.hours) < Number(minH)) { ((other[x.day] ||= {})[k] = ((other[x.day] || {})[k] || 0) + Number(x.hours)); continue }
    ;((hrs[x.day] ||= {})[k] = ((hrs[x.day] || {})[k] || 0) + Number(x.hours || 0))
  }
  const dayKg = {}
  for (const b of batches) dayKg[b.day] = (dayKg[b.day] || 0) + Number(b.kg || 0)
  // whoever had the most production hours that day made the noodles
  const makerOf = d => Object.entries(hrs[d] || {}).sort((x, y) => y[1] - x[1])[0]?.[0]
  const people = Object.keys(names).map(k => {
    let hours = 0, madeH = 0, madeKg = 0, madeN = 0
    const otherH = Object.values(other).reduce((a, m) => a + (m[k] || 0), 0)
    for (const [d, m] of Object.entries(hrs)) {
      if (!m[k]) continue
      hours += m[k]
      if (dayKg[d] && makerOf(d) === k) { madeH += m[k]; madeKg += dayKg[d]; madeN++ }
    }
    return { k, name: names[k], hours, otherH, madeH, madeKg, madeN }
  }).filter(p => p.hours || p.otherH).sort((a, b) => b.hours - a.hours)
  const days = [...new Set([...Object.keys(hrs), ...Object.keys(dayKg), ...Object.keys(other)])].sort().reverse()
  const f = v => fmtNum(r1(v), t.lang)
  return (<>
    <Table title={tr('effTitle')} note={`${tr('shortNote', { h: fmtNum(Number(minH), t.lang) })}. ${tr('effNote')}`}
      head={[tr('person'), tr('prodHours'), tr('otherWork'), tr('madeDays'), tr('kgh')]}
      rows={people.map(p => [p.name, f(p.hours), p.otherH ? `${f(p.otherH)} h` : '–',
        p.madeN ? `${p.madeN} · ${f(p.madeKg)} kg / ${f(p.madeH)} h` : '–', p.madeH ? <b>{f(p.madeKg / p.madeH)}</b> : '–'])} />
    <Table title={tr('dayTitle')} note={tr('dayNote')}
      head={[tr('date'), tr('who'), tr('output'), tr('maker'), tr('kgh')]}
      rows={days.map(d => {
        const m = hrs[d] || {}, h = Object.values(m).reduce((a, x) => a + x, 0)
        const o = Object.entries(other[d] || {}).map(([k, v]) => `${names[k]?.split(' ')[0] || k} ${f(v)} h`).join(' · ')
        return [d, (Object.entries(m).map(([k, v]) => `${names[k]?.split(' ')[0] || k} ${f(v)} h`).join(' · ') || '–') + (o ? ` (${tr('otherWork')}: ${o})` : ''),
          dayKg[d] ? `${f(dayKg[d])} kg` : '–',
          dayKg[d] && makerOf(d) ? names[makerOf(d)]?.split(' ')[0] : '–',
          dayKg[d] && makerOf(d) ? f(dayKg[d] / hrs[d][makerOf(d)]) : '–']
      })} />
  </>)
}

function Kpi({ label, value, sub }) {
  return <div className="kpi"><span className="kpi-label">{label}</span><b className="kpi-value">{value}</b>{sub && <span className="kpi-sub">{sub}</span>}</div>
}

function Table({ title, note, head, rows, foot }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}</h2></div>
      {note && <p className="muted small pad-x">{note}</p>}
      <div className="table-wrap"><table className="table">
        <thead><tr>{head.map((h, i) => <th key={i} className={i ? 'num' : ''}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : ''}>{j === 0 ? <b>{c}</b> : c}</td>)}</tr>)}</tbody>
        {foot && <tfoot><tr>{foot.map((c, j) => <td key={j} className={j ? 'num' : ''}><b>{c}</b></td>)}</tr></tfoot>}
      </table></div>
    </section>
  )
}

function Revenue({ tr, t, rows, revenue, cost, note }) {
  return <Table title={tr('revenue')} note={note} head={[tr('item'), tr('kg'), tr('amount')]}
    rows={[...rows.map(([a, kg, v]) => [a, fmtNum(Math.round(kg * 10) / 10, t.lang), fmtFt(v)]),
      [tr('revTotal'), '', fmtFt(revenue)], [tr('costTotal'), '', `− ${fmtFt(cost)}`]]}
    foot={[tr('profit'), '', fmtFt(revenue - cost)]} />
}

function Scenario({ tr, t, s, avgWage, matKg }) {
  const [h, setH] = useState(10)
  const [kgDay, setKgDay] = useState(n(s.plan_kg_per_hour) * 10 || 50)
  const [daysM, setDaysM] = useState(n(s.work_days_month) || 22)
  const [wage, setWage] = useState(Math.round(avgWage))
  const [price, setPrice] = useState(n(s.internal_price) || 1800)
  const monthKg = kgDay * daysM
  const lab = h * wage * daysM, tax = n(s.tax_per_person_month) * n(s.tax_people)
  const fixed = n(s.rent_month) + n(s.utilities_month)
  const total = lab + tax + fixed + matKg * monthKg
  const cKg = monthKg > 0 ? total / monthKg : 0
  const inp = (v, set, step = 1) => <BlurNum value={v} onCommit={x => set(n(x))} step={step} min={0} className="input-sm" />
  return (
    <section className="panel">
      <div className="panel-head"><h2>{tr('scenario')}</h2></div>
      <div className="form-grid pad-x">
        <label>{tr('hoursDay')} {inp(h, setH, 0.5)}</label>
        <label>{tr('kgDay')} {inp(kgDay, setKgDay)}</label>
        <label>{tr('workDays')} {inp(daysM, setDaysM)}</label>
        <label>{tr('avgWage')} {inp(wage, setWage, 50)}</label>
        <label>{tr('sellPrice')} {inp(price, setPrice, 50)}</label>
      </div>
      <div className="table-wrap"><table className="table">
        <tbody>
          <tr><td><b>{tr('monthKg')}</b></td><td className="num">{fmtNum(Math.round(monthKg), t.lang)} kg · {h > 0 ? fmtNum(Math.round(kgDay / h * 10) / 10, t.lang) : '–'} kg/h</td></tr>
          <tr><td>{tr('labour')}</td><td className="num">{fmtFt(lab)} · {monthKg ? fmtFt(lab / monthKg) : '–'}/kg</td></tr>
          <tr><td>{tr('tax')}</td><td className="num">{fmtFt(tax)} · {monthKg ? fmtFt(tax / monthKg) : '–'}/kg</td></tr>
          <tr><td>{tr('materials')}</td><td className="num">{fmtFt(matKg * monthKg)} · {fmtFt(matKg)}/kg</td></tr>
          <tr><td>{tr('fixed')}</td><td className="num">{fmtFt(fixed)} · {monthKg ? fmtFt(fixed / monthKg) : '–'}/kg</td></tr>
          <tr><td><b>{tr('costPerKg')}</b></td><td className="num"><b>{monthKg ? fmtFt(cKg) : '–'}</b></td></tr>
          <tr><td><b>{tr('marginKg')}</b></td><td className="num"><b>{monthKg ? fmtFt(price - cKg) : '–'}</b></td></tr>
          <tr><td><b>{tr('monthMargin')}</b></td><td className="num"><b>{fmtFt((price - cKg) * monthKg)}</b></td></tr>
        </tbody>
      </table></div>
    </section>
  )
}

function Settings({ tr, s, reload }) {
  const [msg, setMsg] = useState('')
  async function save(key, value) {
    try {
      await q(db.from('cost_settings').upsert({ key, value: n(value), updated_at: new Date().toISOString() }))
      setMsg(tr('saved')); setTimeout(() => setMsg(''), 1500); reload()
    } catch (e) { alert(errText(e)) }
  }
  return (
    <section className="panel">
      <div className="panel-head"><h2>{tr('settings')}</h2>{msg && <span className="muted small">✓ {msg}</span>}</div>
      <div className="form-grid pad-x">
        {SETTING_KEYS.map(k => (
          <label key={k}>{tr(k)} <BlurNum value={s[k] ?? null} min={0} onCommit={v => save(k, v)} className="input-sm" /></label>
        ))}
      </div>
    </section>
  )
}
