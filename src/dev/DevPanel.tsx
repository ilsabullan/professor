import { useRef, useState, useSyncExternalStore } from 'react'
import { latency, summarize, toCsv, type ReqRecord } from '../animation/metrics'
import { type Pipeline } from '../animation/pipeline'
import { drawExample, examplePointing } from '../testboard/examples'
import type { TestBoardController } from '../testboard/controller'
import { LESSONS, type Lesson } from './lessons'

const sec = (a?: number, b?: number) => (a != null && b != null ? ((a - b) / 1000).toFixed(2) : '–')
const ms = (v: number | null) => (v == null ? '–' : `${(v / 1000).toFixed(2)}초`)

function statusClass(r: ReqRecord) {
  if (r.status.startsWith('오류') || r.status === '형식 오류') return 'bad'
  if (r.status === '재생') return 'ok'
  return 'mut'
}

export function DevPanel({
  pipeline: p,
  board,
  lesson,
  onLesson,
}: {
  pipeline: Pipeline
  board: TestBoardController
  lesson: Lesson
  onLesson: (l: Lesson) => void
}) {
  useSyncExternalStore(p.subscribe, p.getVersion)
  const s = p.settings
  const [say, setSay] = useState('')
  const sayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastInput = useRef(0)
  const [csvNote, setCsvNote] = useState('')

  const commitSay = (t: number) => {
    clearTimeout(sayTimer.current)
    const v = say.trim()
    setSay('')
    if (v) p.onFinal(v, t)
  }

  const summary = summarize(p.reqs)
  const recent = [...p.reqs].reverse().slice(0, 40)

  return (
    <aside className="panel">
      <section>
        <h2>가상 교안 (PDF 페이지라고 가정)</h2>
        <div className="row">
          <select
            value={lesson.id}
            onChange={(e) => {
              const l = LESSONS.find((x) => x.id === e.target.value)
              if (l) onLesson(l)
            }}
          >
            {LESSONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {lesson.example && (
            <button className="btn sm" onClick={() => void drawExample(board, lesson.id)}>
              ✏️ 예시 그림
            </button>
          )}
          <button className="btn sm" onClick={() => examplePointing(board, 330, 300, 950, 300)}>
            👉 예시 가리키기
          </button>
        </div>
        <ol className="lesson">
          {lesson.steps.map(([d, t], i) => (
            <li key={i}>
              <span className="d">{d}</span>
              <br />
              <span className="s">{t}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>말하기</h2>
        <div className="row">
          <button className={'btn' + (p.mic === 'on' ? ' rec' : '')} onClick={() => (p.mic === 'on' ? p.speech.stop() : p.speech.start())}>
            {p.mic === 'on' ? '⏹ 마이크 끄기' : '🎤 마이크 켜기'}
          </button>
          <span className="note">{p.micNote || (p.mic === 'on' ? '듣는 중' : '')}</span>
        </div>
        <textarea
          value={say}
          placeholder="마이크가 안 되면 여기에 타이핑하거나 OS 받아쓰기로 말하세요 (맥: fn 두 번). 1.2초 멈추면 한 문장으로 확정, Enter는 즉시 확정"
          onChange={(e) => {
            const v = e.target.value
            setSay(v)
            const t = performance.now()
            lastInput.current = t
            p.onInterim(v, t)
            clearTimeout(sayTimer.current)
            sayTimer.current = setTimeout(() => {
              const val = v.trim()
              setSay('')
              if (val) p.onFinal(val, lastInput.current)
            }, 1200)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commitSay(performance.now())
            }
          }}
        />
        <div className="utt">
          {p.utter.slice(-4).map((u, i) => (
            <div key={i}>· {u.text}</div>
          ))}
          {p.interim && <div className="mut">… {p.interim}</div>}
        </div>
      </section>

      <section>
        <h2>실험 설정</h2>
        <div className="row">
          <label className="opt">
            모델
            <select value={s.model} onChange={(e) => p.update({ model: e.target.value as typeof s.model })}>
              <option value="claude-haiku-5-5">Haiku 5.5 (빠름)</option>
              <option value="claude-sonnet-5-5">Sonnet 5.5</option>
            </select>
          </label>
          <label className="opt">
            생각
            <select value={s.thinking} onChange={(e) => p.update({ thinking: e.target.value as typeof s.thinking })}>
              <option value="off">끔 (빠름)</option>
              <option value="adaptive">켬 (low)</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label className="opt">
            <input type="checkbox" checked={s.quick} onChange={(e) => p.update({ quick: e.target.checked })} /> 즉시 반응
          </label>
          <label className="opt">
            <input type="checkbox" checked={s.early} onChange={(e) => p.update({ early: e.target.checked })} /> 말 끝나기 전 미리 부르기
          </label>
          <label className="opt">
            <input type="checkbox" checked={s.scene} onChange={(e) => p.update({ scene: e.target.checked })} /> 장면 해석
          </label>
          <label className="opt">
            필기 이미지
            <select value={s.image} onChange={(e) => p.update({ image: e.target.value as typeof s.image })}>
              <option value="auto">손글씨 있을 때만</option>
              <option value="off">안 보냄 (빠름)</option>
              <option value="on">항상</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label className="opt">
            확신 기준
            <input type="range" min={0} max={0.9} step={0.05} value={s.thr} onChange={(e) => p.update({ thr: Number(e.target.value) })} />
          </label>
          <span className="mut">{s.thr.toFixed(2)}</span>
          <button className="btn sm" onClick={() => p.resetAnimation()}>
            애니메이션 초기화
          </button>
        </div>
      </section>

      <section>
        <h2>AI가 지금 한 일</h2>
        <div className="note">{p.aiNote}</div>
        {s.scene && <div className="note">장면 해석: {sceneNote(p.scene.status)}</div>}
        {p.quickLog.length > 0 && (
          <div className="utt">
            {p.quickLog.map((q, i) => (
              <div key={i} className="mut">
                ⚡ {q}
              </div>
            ))}
          </div>
        )}
        <pre className="raw">{p.aiRaw || '아직 없음'}</pre>
      </section>

      <section>
        <h2>측정 요약 (행동 → AI 첫 동작)</h2>
        <div className="note">중앙값·90%·1초 이내는 첫 동작이 관측된 요청만 기준입니다. 미확정 발화 요청은 제외하며, 무반응은 의도된 결과일 수도 있습니다. 음성 기준 시각은 인식 결과로 추정합니다.</div>
        {summary.length === 0 ? (
          <div className="note">기록이 없어요. 그리거나 말하면 쌓여요.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="l">설정</th>
                <th>반응/전체</th>
                <th>중앙값</th>
                <th>90%</th>
                <th>반응 중 1초</th>
                <th>즉시</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((g) => (
                <tr key={g.cfg}>
                  <td className="l">{g.cfg}</td>
                  <td>
                    {g.played}/{g.count}
                  </td>
                  <td className={g.p50 != null && g.p50 <= 1000 ? 'ok' : 'bad'}>{ms(g.p50)}</td>
                  <td>{ms(g.p90)}</td>
                  <td>{g.under1s == null ? '–' : `${Math.round(g.under1s * 100)}%`}</td>
                  <td>{g.quickP50 == null ? '–' : `${Math.round(g.quickP50)}ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {summary.map((g) => (
          <div className="note" key={g.cfg}>
            {g.cfg}: 중단 {g.aborted} · 오류 {g.errors} · 무반응 {g.noMovement} · 보류 {g.held} · 진행 중 {g.pending}
          </div>
        ))}
        <div className="row">
          <button
            className="btn sm"
            onClick={() => {
              void navigator.clipboard
                .writeText(toCsv(p.reqs))
                .then(() => setCsvNote('복사했어요'))
                .catch(() => setCsvNote('복사 실패'))
            }}
          >
            CSV 복사
          </button>
          <button
            className="btn sm"
            onClick={() => {
              const url = URL.createObjectURL(new Blob(['﻿' + toCsv(p.reqs)], { type: 'text/csv' }))
              const a = document.createElement('a')
              a.href = url
              a.download = `latency-${Date.now()}.csv`
              a.click()
              URL.revokeObjectURL(url)
            }}
          >
            CSV 저장
          </button>
          <button className="btn sm" onClick={() => p.clearRecords()}>
            기록 비우기
          </button>
          <span className="note">{csvNote}</span>
        </div>
      </section>

      <section className="grow">
        <h2>요청별 기록 (초, 행동 시각 기준)</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className="l">#</th>
                <th className="l">계기</th>
                <th>즉시</th>
                <th>첫토큰</th>
                <th>첫동작</th>
                <th>체감</th>
                <th className="l">상태</th>
                <th className="l">자막</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => {
                const lat = latency(r)
                return (
                  <tr key={r.id} title={`${r.cfg} · ${r.desc}`}>
                    <td className="l">{r.id}</td>
                    <td className="l">{r.kind}</td>
                    <td>{r.quickMs == null ? '–' : `${Math.round(r.quickMs)}ms`}</td>
                    <td>{sec(r.tFirst, r.t0)}</td>
                    <td>{sec(r.tFirstOp, r.t0)}</td>
                    <td className={lat == null ? 'mut' : lat <= 1000 ? 'ok' : 'bad'}>{lat == null ? '–' : (lat / 1000).toFixed(2)}</td>
                    <td className={'l ' + statusClass(r)}>{r.status}</td>
                    <td className="l say">{r.cap}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </aside>
  )
}

function sceneNote(st: Pipeline['scene']['status']) {
  const now = st.state === 'running' ? '해석 중 · ' : st.state === 'waiting' ? '대기 · ' : ''
  const l = st.last
  if (!l) return now + '아직 없음'
  return `${now}마지막 ${l.ms}ms · ${l.discarded ?? `객체 ${l.objs}개${l.merged ? ` · 묶음 ${l.merged}` : ''}${l.split ? ` · 나눔 ${l.split}` : ''}`}`
}
