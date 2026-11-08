import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { PickupLane, PickupStop } from '@tours/core'
import { useEffect, useRef } from 'react'

export const LANE_COLORS = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#1d4ed8', '#4d7c0f']

const icon = (label: string, color: string) => L.divIcon({
  className: 'pickup-marker',
  html: `<span style="background:${color}">${label}</span>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
})

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Bản đồ các điểm đón. Đường nối là đường thẳng giữa các điểm, không phải đường xe chạy thật. */
export function PickupMap({ lanes, editable, picking, onMove, onPick }: {
  lanes: PickupLane[]
  editable: boolean
  picking: boolean
  onMove: (stop: PickupStop, lat: number, lng: number) => void
  onPick: (lat: number, lng: number) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const fitted = useRef('')
  // Trình xử lý sự kiện của bản đồ chỉ gắn một lần, nên đọc hàm mới nhất qua ref.
  const handlers = useRef({ onMove, onPick, picking })
  handlers.current = { onMove, onPick, picking }

  useEffect(() => {
    if (!box.current) return
    const m = L.map(box.current, { scrollWheelZoom: false }).setView([21.03, 105.85], 13)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    }).addTo(m)
    m.on('click', (e: L.LeafletMouseEvent) => {
      if (handlers.current.picking) handlers.current.onPick(e.latlng.lat, e.latlng.lng)
    })
    layer.current = L.layerGroup().addTo(m)
    map.current = m
    // Bản đồ nằm trong tab: phải đo lại kích thước khi khung đổi.
    const observer = new ResizeObserver(() => m.invalidateSize())
    observer.observe(box.current)
    return () => {
      observer.disconnect()
      m.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    const m = map.current
    const group = layer.current
    if (!m || !group) return
    group.clearLayers()
    const bounds: L.LatLngTuple[] = []
    lanes.forEach((lane, laneIndex) => {
      const color = LANE_COLORS[laneIndex % LANE_COLORS.length]!
      const line: L.LatLngTuple[] = []
      lane.stops.forEach((stop, i) => {
        if (!stop.position) return
        const at: L.LatLngTuple = [stop.position.lat, stop.position.lng]
        line.push(at)
        bounds.push(at)
        const marker = L.marker(at, { icon: icon(String(i + 1), color), draggable: editable, title: stop.name })
        marker.bindPopup(`<b>${escapeHtml(stop.name)}</b><br/>${stop.time ? `${stop.time} · ` : ''}${stop.pax} khách<br/>${escapeHtml(lane.name)}`)
        marker.on('dragend', () => {
          const p = marker.getLatLng()
          handlers.current.onMove(stop, p.lat, p.lng)
        })
        marker.addTo(group)
      })
      if (line.length > 1) L.polyline(line, { color, weight: 3, opacity: 0.7, dashArray: '6 6' }).addTo(group)
    })
    // Chỉ căn lại khung khi tập điểm đổi, để kéo một điểm không làm bản đồ nhảy.
    const signature = bounds.map(([lat, lng]) => `${lat.toFixed(2)},${lng.toFixed(2)}`).sort().join('|')
    if (bounds.length && signature !== fitted.current) {
      fitted.current = signature
      m.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 })
    }
  }, [lanes, editable])

  return <div ref={box} className={`pickup-map${picking ? ' picking' : ''}`} role="application" aria-label="Bản đồ điểm đón" />
}
