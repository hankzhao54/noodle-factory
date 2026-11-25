import { useEffect, useRef, useState } from 'react'
import { Modal } from './ui'
import { useT } from '../lib/i18n'

// Camera QR scanner (works in iPhone Safari too: frames are decoded with jsQR, no BarcodeDetector needed).
// onResult(text) is called once with the first code found; the camera is switched off on close.
export default function QrScanner({ onResult, onClose }) {
  const t = useT()
  const video = useRef(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let stream, raf, done = false, jsQR
    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d', { willReadFrequently: true })
    async function start() {
      try {
        jsQR = (await import('jsqr')).default
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (done) { stream.getTracks().forEach(tr => tr.stop()); return }
        const v = video.current
        v.srcObject = stream
        v.setAttribute('playsinline', 'true')
        await v.play()
        tick()
      } catch (e) {
        if (done || e?.name === 'AbortError') return   // closed meanwhile (or React re-ran the effect)
        setErr(e?.name === 'NotAllowedError' ? t('scanNoCamera') : (e?.message || String(e)))
      }
    }
    function tick() {
      if (done) return
      const v = video.current
      if (v && v.readyState >= 2 && v.videoWidth) {
        // decode a centred square, scaled down: fast enough on phones
        const side = Math.min(v.videoWidth, v.videoHeight), s = Math.min(640, side)
        canvas.width = canvas.height = s
        g.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, s, s)
        const code = jsQR(g.getImageData(0, 0, s, s).data, s, s, { inversionAttempts: 'dontInvert' })
        if (code?.data) { done = true; navigator.vibrate?.(40); onResult(code.data); return }
      }
      raf = requestAnimationFrame(tick)
    }
    start()
    return () => { done = true; cancelAnimationFrame(raf); stream?.getTracks().forEach(tr => tr.stop()) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal title={`📷 ${t('scanTitle')}`} onClose={onClose}>
      {err ? <p className="error-box">{err}</p> : <>
        <div className="scan-box"><video ref={video} muted playsInline /><span className="scan-frame" /></div>
        <p className="muted small">{t('scanHint')}</p>
      </>}
      <div className="modal-foot"><span className="grow" /><button className="btn" onClick={onClose}>{t('close')}</button></div>
    </Modal>
  )
}

// lot number from a scanned label: the trace link (…/trace/261123-30) or the lot itself
export function lotFromScan(text) {
  const s = String(text || '').trim()
  const m = s.match(/\/trace\/([^/?#\s]+)/)
  const lot = decodeURIComponent(m ? m[1] : s)
  return /^[\w-]{3,40}(\/P\d+)?$/.test(lot) ? lot.replace(/\/P\d+$/, '') : null
}
