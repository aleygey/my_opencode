/** @jsxImportSource react */

interface SpinProps {
  size?: number
  line?: number
  tone?: string
}

export function Spin(props: SpinProps) {
  const size = props.size ?? 16
  const line = props.line ?? 1.8
  const tone = props.tone ?? 'var(--wf-ink-soft)'

  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        className="wf-spin"
        viewBox="0 0 24 24"
        fill="none"
        style={{ width: size, height: size }}
      >
        <circle cx="12" cy="12" r="8.25" stroke="rgba(107,114,128,0.18)" strokeWidth={line} />
        <path
          d="M12 3.75A8.25 8.25 0 0 1 20.25 12"
          stroke={tone}
          strokeWidth={line}
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}
