import { useState, useSyncExternalStore } from 'react'
import type { Pipeline } from '../animation/pipeline'
import { DevPanel } from './DevPanel'
import { LESSONS, type Lesson } from './lessons'
import { flush, logSession } from './testlog'
import './lab.css'

const AI_CHIP: Record<Pipeline['aiStatus'], [string, string]> = {
  checking: ['', 'AI: 확인 중'],
  ready: ['ok', 'AI: 연결됨'],
  nokey: ['warn', 'AI: 키 없음'],
  locked: ['warn', 'AI: 접속 코드 필요'],
  error: ['bad', 'AI: 프록시 없음'],
}

/** 편집기 오른쪽에 붙는 애니메이션 레이어 테스트 패널 */
export function TestPanel({ pipeline }: { pipeline: Pipeline }) {
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

  const [aiCls, aiText] = AI_CHIP[pipeline.aiStatus]
  const micText = pipeline.mic === 'on' ? '마이크: 듣는 중' : pipeline.mic === 'off' ? '마이크: 꺼짐' : '마이크: 받아쓰기 모드'

  return (
    <div className="lab">
      <div className="lab-head">
        <span className="sub">애니메이션 레이어 테스트 · 기록 {logSession}</span>
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
      </div>
      <DevPanel pipeline={pipeline} lesson={lesson} onLesson={setLesson} />
    </div>
  )
}
