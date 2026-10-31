import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Pipeline } from './animation/pipeline'
import { InkBus } from './shared/bus'
import { LESSONS } from './dev/lessons'
import { TestBoardController } from './testboard/controller'
import { drawExample } from './testboard/examples'
import { logEntry, startTestLog } from './dev/testlog'
import './styles.css'

// 한 번만 만든다. 애니메이션 쪽이 먼저 구독해야 편집기의 첫 이벤트(page)를 받는다
const bus = new InkBus()
const pipeline = new Pipeline(bus)
const board = new TestBoardController(bus)

// 개발 중에는 테스트 기록을 서버(logs/)에 쌓는다
if (import.meta.env.DEV) {
  pipeline.log = logEntry
  startTestLog()
}

// 개발 중 콘솔에서 상태를 보거나 simulate()·측정 스크립트로 시험할 수 있게
if (import.meta.env.DEV) Object.assign(window, { __pipeline: pipeline, __board: board, __dev: { drawExample, LESSONS } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App pipeline={pipeline} board={board} />
  </StrictMode>,
)
