// Shrink phone photos before upload: max 1600px on the long side, JPEG ~80%.
// Falls back to the original file when the browser can't decode it (e.g. HEIC on Chrome).
export async function compressImage(file, maxSide = 1600, quality = 0.8) {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality))
    return blob ? { blob, ext: 'jpg', type: 'image/jpeg' } : { blob: file, ext: extOf(file), type: file.type }
  } catch {
    return { blob: file, ext: extOf(file), type: file.type || 'image/jpeg' }
  }
}

function extOf(file) {
  const m = /\.([a-z0-9]+)$/i.exec(file.name || '')
  return (m ? m[1] : 'jpg').toLowerCase()
}
