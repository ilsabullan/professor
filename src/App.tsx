import { useEffect, useState, useSyncExternalStore } from 'react'
import { AnimationOverlay } from './animation/AnimationOverlay'
import type { Pipeline } from './animation/pipeline'
import { DevPanel } from './dev/DevPanel'
import { flush, logSession } from './dev/testlog'
import { LESSONS, type Lesson, PAGE_H, PAGE_W } from './dev/lessons'
import type { TestBoardController } from './testboard/controller'
import { TestBoard } from './testboard/TestBoard'

const AI_CHIP: Record<Pipeline['aiStatus'], [string, string]> = {
  checking: ['', 'AI: 확인 중'],
  ready: ['ok', 'AI: 연결됨'],
  nokey: ['warn', 'AI: 키 없음'],
  locked: ['warn', 'AI: 접속 코드 필요'],
  error: ['bad', 'AI: 프록시 없음'],
}

export function App({ pipeline, board }: { pipeline: Pipeline; board: TestBoardController }) {
  useSyncExternalStore(pipeline.subscribe, pipeline.getVersion)
  const [lesson, setLesson] = useState<Lesson>(LESSONS[0])
  const [issues, setIssues] = useState(0)

  const submit = () => {
    const note = window.prompt('이번 실측 보내기. 한 줄 메모 (비워도 됨)')
    if (note === null) return
    pipeline.submit(note)
    flush()
  }

  const markIssue = () => {
    const note = window.prompt('무엇이 의도와 달랐나요? (예: 5와 3이 안 바뀜, 배열인데 흐름이 나옴)')
    if (note === null) return
    pipeline.markIssue(note)
    setIssues((n) => n + 1)
  }

  useEffect(() => {
    board.openPage({ page: 1, width: PAGE_W, height: PAGE_H, text: lesson.text })
  }, [board, lesson])

  const [aiCls, aiText] = AI_CHIP[pipeline.aiStatus]
  const micText = pipeline.mic === 'on' ? '마이크: 듣는 중' : pipeline.mic === 'off' ? '마이크: 꺼짐' : '마이크: 받아쓰기 모드'

  return (
    <div className="app">
      <header>
        <h1>살아있는 칠판</h1>
        <span className="sub">교수자 · 애니메이션 레이어 테스트 · 기록 {logSession}</span>
        <div className="chips">
          <button className="btn sm" onClick={submit}>
            📤 보내기{pipeline.submitted ? ` (${pipeline.submitted})` : ''}
          </button>
          <button className="btn sm issue" onClick={markIssue}>
            🚩 문제 표시{issues ? ` (${issues})` : ''}
          </button>
          <span className={'chip ' + aiCls}>{aiText}</span>
          <span className={'chip ' + (pipeline.mic === 'on' ? 'ok' : pipeline.mic === 'off' ? '' : 'warn')}>{micText}</span>
        </div>
      </header>
      <main>
        <div className="stage-wrap">
          <div className="stage" style={{ aspectRatio: `${PAGE_W} / ${PAGE_H}` }}>
            <TestBoard ctrl={board} />
            <AnimationOverlay pipeline={pipeline} />
          </div>
        </div>
        <DevPanel pipeline={pipeline} board={board} lesson={lesson} onLesson={setLesson} />
      </main>
    </div>
  )
}
