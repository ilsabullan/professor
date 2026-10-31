import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Pipeline } from './pipeline'

const MAX_PIXELS = 8_000_000

/**
 * 필기 캔버스 위에 겹치는 투명 애니메이션 레이어.
 * 부모가 필기 캔버스와 같은 크기·위치로 놓아 주면 된다 (페이지 좌표 → 화면 크기로 자동 맞춤).
 * showCaption: AI가 한 일 설명과 ✓/✗ 피드백. 실험실(테스트 패널)을 켰을 때만 보인다
 */
export function AnimationOverlay({ pipeline, showCaption = true }: { pipeline: Pipeline; showCaption?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useSyncExternalStore(pipeline.subscribe, pipeline.getVersion)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    let raf = 0
    let last = performance.now()
    const loop = () => {
      const now = performance.now()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      pipeline.tick(now, dt)
      const r = cv.getBoundingClientRect()
      // 많이 확대하면 캔버스가 너무 커져 아이패드 사파리에서 그려지지 않으므로 픽셀 수를 제한한다
      const d = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / Math.max(1, r.width * r.height)))
      const w = Math.max(1, Math.round(r.width * d))
      const h = Math.max(1, Math.round(r.height * d))
      if (cv.width !== w || cv.height !== h) {
        cv.width = w
        cv.height = h
      }
      const c = cv.getContext('2d')!
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.clearRect(0, 0, w, h)
      const sc = (r.width / pipeline.board.page.width) * d
      c.setTransform(sc, 0, 0, sc, 0, 0)
      pipeline.engine.render(c)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [pipeline])

  return (
    <div className="overlay">
      <canvas ref={ref} />
      {showCaption && pipeline.caption && (
        <div className="caption">
          {pipeline.caption}
          {pipeline.lastPlayed && (
            <span className="fb">
              {pipeline.lastPlayed.feedback ? (
                <span className="fb-done">{pipeline.lastPlayed.feedback === 'ok' ? '✓' : '✗'} 기록됨</span>
              ) : (
                <>
                  <button onClick={() => pipeline.feedback(true)} title="의도대로 됨">
                    ✓
                  </button>
                  <button
                    onClick={() => {
                      const note = window.prompt('무엇이 달랐나요? (비워도 됨)') ?? ''
                      pipeline.feedback(false, note)
                    }}
                    title="의도와 다름"
                  >
                    ✗
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
