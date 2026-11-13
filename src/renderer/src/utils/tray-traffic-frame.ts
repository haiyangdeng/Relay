import {
  readTrayTrafficFrame,
  trayTrafficFrameHeight,
  trayTrafficFrameWidth
} from '../../../shared/relay/tray-traffic-frame'
import { calcTraffic } from './calc'

export function listenForTrayTrafficFrames(): () => void {
  let busy = false
  return window.electron.ipcRenderer.on('relayTrayTrafficDraw', (_event, raw) => {
    const frame = readTrayTrafficFrame(raw)
    if (!frame || busy) return
    busy = true
    void (async () => {
      // Fixed v2.0.4 conn-card.tsx renders the icon and two traffic lines on a
      // 156 × 36 canvas. Relay provides the frame and receives a short-lived image.
      const logo = new Image()
      logo.src = frame.icon
      await logo.decode()
      const canvas = document.createElement('canvas')
      canvas.width = trayTrafficFrameWidth
      canvas.height = trayTrafficFrameHeight
      const context = canvas.getContext('2d')
      if (!context) return
      const height = trayTrafficFrameHeight
      const scale = height / Math.max(logo.naturalWidth, logo.naturalHeight)
      const width = logo.naturalWidth * scale
      const imageHeight = logo.naturalHeight * scale
      context.drawImage(logo, (height - width) / 2, (height - imageHeight) / 2, width, imageHeight)
      if (frame.iconTint) {
        context.globalCompositeOperation = 'source-in'
        context.fillStyle = frame.iconTint
        context.fillRect(0, 0, height, height)
        context.globalCompositeOperation = 'source-over'
      }
      context.font = 'bold 18px "PingFang SC"'
      context.fillStyle = frame.textColor
      context.textAlign = 'right'
      context.fillText(`${calcTraffic(frame.up)}/s`, trayTrafficFrameWidth, 15)
      context.fillText(`${calcTraffic(frame.down)}/s`, trayTrafficFrameWidth, 34)
      await window.electron.ipcRenderer.invoke('relayTrayTrafficFrame', {
        id: frame.id,
        png: canvas.toDataURL('image/png')
      })
    })()
      .catch(() => {
        // The tray keeps its native title if the frame cannot be painted.
      })
      .finally(() => {
        busy = false
      })
  })
}
