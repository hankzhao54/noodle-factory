import { jsPDF } from 'jspdf'

// Ways to get finished label canvases to the Brother printer.
//   phone / tablet: PNG images via the share sheet → AirPrint (what works on iPhone)
//   computer: one PDF with pages exactly the label size, opened in a new tab
export const isTouch = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

export async function shareCanvases(canvases, baseName) {
  const files = []
  for (let i = 0; i < canvases.length; i++) {
    const blob = await new Promise(r => canvases[i].toBlob(r, 'image/png'))
    files.push(new File([blob], `${baseName}-${String(i + 1).padStart(2, '0')}.png`, { type: 'image/png' }))
  }
  if (navigator.canShare?.({ files })) { await navigator.share({ files }); return }
  files.forEach(f => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(f); a.download = f.name; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  })
}

export function pdfFromCanvases(canvases, w, h) {
  const orient = w > h ? 'landscape' : 'portrait'
  const pdf = new jsPDF({ unit: 'mm', format: [w, h], orientation: orient, compress: true })
  canvases.forEach((c, i) => {
    if (i) pdf.addPage([w, h], orient)
    pdf.addImage(c.toDataURL('image/png'), 'PNG', 0, 0, w, h, undefined, 'FAST')
  })
  return pdf.output('blob')
}

// share sheet on touch devices, else a new tab (or this tab if pop-ups are blocked)
export function deliverPdf(blob, name) {
  const file = new File([blob], `${name}.pdf`, { type: 'application/pdf' })
  if (isTouch() && navigator.canShare?.({ files: [file] })) {
    return navigator.share({ files: [file] }).catch(e => { if (e?.name !== 'AbortError') openBlob(blob) })
  }
  openBlob(blob)
}
function openBlob(blob) {
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank')
  if (!win) window.location.href = url
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
