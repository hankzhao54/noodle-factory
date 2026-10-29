import { useState } from 'react'
import { imageUrl } from '../lib/images'

// small square photo; shows a soft placeholder when there is no photo or it fails to load
export default function ImageThumb({ path, src, size = 40, alt = '', onClick }) {
  const [broken, setBroken] = useState(false)
  const url = src || imageUrl(path)
  const style = { width: size, height: size }
  if (!url || broken) return <span className="thumb thumb-empty" style={style} aria-hidden="true" />
  const img = <img className="thumb" style={style} src={url} alt={alt} loading="lazy" onError={() => setBroken(true)} />
  return onClick ? <button type="button" className="thumb-btn" onClick={onClick}>{img}</button> : img
}
