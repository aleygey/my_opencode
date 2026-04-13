/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react'

interface SplitOpts {
  axis: 'x' | 'y'
  size: number
  min: number
  max: number
  dir?: 1 | -1
}

export function useSplit(opts: SplitOpts) {
  const [size, setSize] = useState(opts.size)
  const ref = useRef<{ pos: number; size: number } | null>(null)

  useEffect(() => {
    setSize((v) => clamp(v, opts.min, opts.max))
  }, [opts.min, opts.max])

  useEffect(() => {
    const move = (evt: MouseEvent) => {
      if (!ref.current) return
      const next = ref.current.size + (pick(evt, opts.axis) - ref.current.pos) * (opts.dir ?? 1)
      setSize(clamp(next, opts.min, opts.max))
    }
    const up = () => {
      ref.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [opts.axis, opts.dir, opts.max, opts.min])

  return {
    size,
    setSize,
    bind: {
      onMouseDown: (evt: React.MouseEvent<HTMLDivElement>) => {
        ref.current = { pos: pick(evt.nativeEvent, opts.axis), size }
        document.body.style.cursor = opts.axis === 'x' ? 'col-resize' : 'row-resize'
        document.body.style.userSelect = 'none'
      },
    },
  }
}

export function SplitBar(props: { axis: 'x' | 'y'; onMouseDown: (evt: React.MouseEvent<HTMLDivElement>) => void }) {
  const line = props.axis === 'x' ? 'h-full w-px' : 'h-px w-full'
  const pad = props.axis === 'x' ? 'h-full w-3 cursor-col-resize' : 'h-3 w-full cursor-row-resize'

  return (
    <div
      className={['group relative flex flex-shrink-0 items-center justify-center select-none', pad].join(' ')}
      onMouseDown={props.onMouseDown}
      role="separator"
      aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'}
    >
      <div className={['bg-[var(--wf-line)] transition group-hover:bg-[var(--wf-line-strong)]', line].join(' ')} />
    </div>
  )
}

function pick(evt: MouseEvent, axis: 'x' | 'y') {
  return axis === 'x' ? evt.clientX : evt.clientY
}

function clamp(size: number, min: number, max: number) {
  return Math.min(max, Math.max(min, size))
}
