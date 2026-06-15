// Kubernetes logo wheel. Brand-colored by default; pass `color` for a
// monochrome outline that sits alongside other line icons.
export default function K8sIcon({ size = 16, className = '', color }: { size?: number; className?: string; color?: string }) {
  const spokes = Array.from({ length: 7 }).map((_, i) => {
    const angle = (i * 360) / 7 - 90
    const rad = (angle * Math.PI) / 180
    return {
      x1: 24 + 7 * Math.cos(rad),
      y1: 24 + 7 * Math.sin(rad),
      x2: 24 + 16 * Math.cos(rad),
      y2: 24 + 16 * Math.sin(rad),
      tipX: 24 + 16.5 * Math.cos(rad),
      tipY: 24 + 16.5 * Math.sin(rad),
    }
  })

  if (color) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20.5" stroke={color} strokeWidth="3" fill="none" />
        {spokes.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={color} strokeWidth="2.4" strokeLinecap="round" />
        ))}
        <circle cx="24" cy="24" r="4.5" fill={color} />
      </svg>
    )
  }

  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="24" r="22" fill="#326CE5" />
      {spokes.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="white" strokeWidth="2.2" strokeLinecap="round" />
      ))}
      <circle cx="24" cy="24" r="5.5" fill="white" />
      <circle cx="24" cy="24" r="3" fill="#326CE5" />
      {spokes.map((s, i) => (
        <circle key={i} cx={s.tipX} cy={s.tipY} r="2.2" fill="white" />
      ))}
    </svg>
  )
}
