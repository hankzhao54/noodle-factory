// Packing of an order line: vacuum bags (usually 2–3 kg) and / or portions of N grams.
// Fees are per kg and copied onto the line when ordered (vacuum_fee, portion_fee); own restaurants pay none.
// Fee settings come from public_info(): packing_vacuum_fee, packing_portion_fee, packing_bag_text.

export const packFees = info => ({
  vacuum: Number(info?.packing_vacuum_fee ?? 150) || 0,
  portion: Number(info?.packing_portion_fee ?? 150) || 0,
  bag: info?.packing_bag_text || '2–3 kg',
})

// fee per kg of one line (stored fees win; otherwise the current settings)
export const lineFee = (l, fees) =>
  l.vacuum_fee != null || l.portion_fee != null
    ? Number(l.vacuum_fee || 0) + Number(l.portion_fee || 0)
    : (l.pack_vacuum ? fees?.vacuum || 0 : 0) + (l.portion_g ? fees?.portion || 0 : 0)

export const hasPacking = l => !!(l?.pack_vacuum || l?.portion_g)

// short text for lists, delivery notes and labels: "Vákuum 2–3 kg + 120 g adag"
export function packText(t, l, bag) {
  if (!hasPacking(l)) return ''
  return [l.pack_vacuum && t('packVacuumShort', { bag: bag || '2–3 kg' }), l.portion_g && t('packPortionShort', { g: l.portion_g })].filter(Boolean).join(' + ')
}

// the same in Hungarian, for invoices
export function packTextHu(l, bag) {
  if (!hasPacking(l)) return ''
  return [l.pack_vacuum && `vákuumcsomagolás (${bag || '2–3 kg'}/zsák)`, l.portion_g && `adagolás ${l.portion_g} g`].filter(Boolean).join(' + ')
}
