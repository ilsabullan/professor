import { useEffect, useRef, useState } from 'react'
import type { TestBoardController, Tool } from './controller'

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'pen', label: '✏️ 펜', key: 'V' },
  { tool: 'text', label: 'T 글자', key: 'T' },
  { tool: 'erase', label: '⌫ 지우개', key: 'E' },
  { tool: 'point', label: '👉 가리키기', key: 'P' },
]

export function TestBoard({ ctrl }: { ctrl: TestBoardController }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [tool, setTool] = useState<Tool>(ctrl.tool)
  const [textAt, setTextAt] = useState<{ x: number; y: number; left: number; top: number } | null>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    ctrl.attach(cv)
    ctrl.onToolChange = setTool
    ctrl.onTextRequest = setTextAt
    return () => {
      ctrl.detach()
      ctrl.onToolChange = null
      ctrl.onTextRequest = null
    }
  }, [ctrl])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return
      const hit = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase())
      if (hit) ctrl.setTool(hit.tool)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctrl])

  return (
    <>
      <canvas ref={ref} className="board" style={{ cursor: tool === 'erase' ? 'cell' : tool === 'point' ? 'crosshair' : 'default' }} />
      <div className="tools">
        {TOOLS.map((t) => (
          <button key={t.tool} className={'btn sm' + (tool === t.tool ? ' on' : '')} title={`${t.key} 키`} onClick={() => ctrl.setTool(t.tool)}>
            {t.label}
          </button>
        ))}
        <button className="btn sm" onClick={() => ctrl.undo()}>
          되돌리기
        </button>
        <button className="btn sm" onClick={() => ctrl.clear()}>
          전부 지우기
        </button>
      </div>
      {textAt && (
        <input
          className="textbox"
          style={{ left: textAt.left, top: textAt.top - 16 }}
          autoFocus
          placeholder="글자 입력 후 Enter"
          onBlur={() => setTextAt(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = e.currentTarget.value.trim()
              if (v) ctrl.addText(v, textAt.x, textAt.y)
              setTextAt(null)
              ctrl.setTool('pen')
            }
            if (e.key === 'Escape') setTextAt(null)
          }}
        />
      )}
    </>
  )
}
