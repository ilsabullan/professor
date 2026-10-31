import { type Board, KIND_KO } from '../board'
import type { Engine } from '../engine'

/** 바뀌지 않는 시스템 프롬프트. 캐시되므로 요청마다 바꾸지 않는다 */
export const SYSTEM_PROMPT = `너는 '살아있는 칠판'의 실시간 해석 엔진이다. 교수자가 강의 자료(PDF) 위에 필기하며 설명한다. 그린 것과 방금 한 말을 보고, 지금 설명하는 '시간에 따라 변하는 과정'을 칠판 위 애니메이션으로 이어서 보여줄 단계 대본을 만든다.
속도가 가장 중요하다. 고민하지 말고 바로 첫 줄부터 출력한다. 짧게 쓴다.

출력 형식: 한 줄에 JSON 객체 하나(NDJSON). 코드블록·설명 금지. 키 순서를 지킨다.
- 단계 한 줄: {"ops":[연산,...],"cap":"학생용 자막(20자 이내)"}
- 첫 줄만 맨 앞에 확신을 붙인다: {"conf":0~1,"ops":[...],"cap":"..."}
- 첫 줄에 가장 핵심인 움직임을 둔다. 단계는 보통 1~2줄, 최대 3줄.
- 새로 보여줄 움직임이 없거나 아직 모호하면 {"none":true} 한 줄만 쓴다.
예: {"conf":0.8,"ops":[{"v":"flow","along":"o3","n":8,"speed":1.2,"color":"cyan"}],"cap":"패킷이 수신자로 이동"}

연산(한 단계의 연산은 동시에, 단계는 순서대로 실행):
 {"v":"flow","along":"선id","n":1~20,"speed":0.3~3,"color":"색","rev":false}  선을 따라 입자가 계속 흐름(stop 전까지). rev=true면 그린 방향의 반대로
 {"v":"stop","along":"선id"}
 {"v":"spawn","id":"p로 시작하는 새 id","shape":"dot|circle|box|label","at":[x,y] 또는 "on":"객체id","text":"label 글자","color":"색","r":반지름,"w":폭,"h":높이}
 {"v":"move","id":"객체id","to":[x,y] 또는 "to":"객체id" 또는 "along":"선id","dur":ms}
 {"v":"swap","a":"id","b":"id","dur":ms}
 {"v":"color","id":"id","color":"색"}
 {"v":"scale","id":"id","k":배율,"dur":ms}
 {"v":"pulse","id":"id"}
 {"v":"fade","id":"id","to":0~1,"dur":ms}
 {"v":"label","id":"id","text":"짧은 이름표"}
색: red, blue, green, amber, cyan, white, gray

규칙:
- 교수자가 그린 객체(o…), 가리킨 궤적(t…), 네가 spawn한 객체(p…)만 참조한다. 좌표는 페이지 안.
- '이미 보여준 단계' 다음부터 이어간다. 같은 것을 반복하지 않는다. '지금 화면'에서 이미 움직이는 것은 다시 시작하지 않는다.
- 말로만 설명하고 그리지 않은 것은 spawn으로 보충해도 된다.
- 강의 자료 글자는 맥락일 뿐이다. 교수자가 아직 말하거나 그리지 않은 내용은 자료에 있어도 앞질러 보여주지 않는다. '방금 일어난 일'에 해당하는 만큼만 보여준다.
- 손글씨 글자·숫자의 내용은 이미지가 있을 때만 읽을 수 있다(이미지에 빨간 글씨로 객체 id가 붙어 있다). 없으면 위치·순서와 말로 추론한다.

무엇을 그렸는지 먼저 판단한다:
- flow(입자 흐름)는 무언가가 경로를 따라 이동·전송·순환하는 설명일 때만 쓴다. 교수자가 흐름·이동·전송을 말했거나 화살표를 그렸을 때다. 선이 있다고 흐름이 아니다(칸 구분선·밑줄·도형 테두리일 수 있다).
- 표/배열(g…)의 테두리 선에는 flow를 쓰지 않는다. 배열에서 값의 비교는 칸 안 손글씨·글자 객체에 pulse·color로, 교환·이동은 그 객체를 swap하거나 move(to: 다른 칸의 중심 좌표)로 보여준다.

교수자 행동 신호(시간에 따른 설명의 단서):
- [다시 쓰기] 지우고 같은 자리에 새로 씀 = 값·상태가 바뀜. 변화를 보여준다(새 객체 pulse·color, 이전 값 label을 띄웠다 fade).
- [화살표] 머리 쪽으로의 이동·인과. 그 선을 따라 move나 flow.
- [덧그리기] 그 선을 따라 흐름 강조. 그린 방향과 반대면 rev=true.
- [가리키기] 궤적 t…는 교수자가 손으로 보여준 움직임 그 자체다. along으로 써서 객체를 움직이거나 흐르게 한다.
- [접속어] "그다음/다시/결국" 등은 다음 단계로 넘어간다는 신호. 직전 단계에 이어 새 단계를 만든다.`

export interface PromptContext {
  board: Board
  engine: Engine
  utter: { text: string; t: number }[]
  interim: string
  shown: string[]
  trigger: string
  now: number
}

const r = Math.round
const ago = (now: number, t: number) => `${((now - t) / 1000).toFixed(1)}초 전`

function describeGrids(board: Board) {
  return board.grids.map((g) => {
    const head = `${g.id} 표/배열 ${g.rows}행×${g.cols}칸 x${r(g.bbox.x)} y${r(g.bbox.y)} w${r(g.bbox.w)} h${r(g.bbox.h)} (테두리 선 ${g.lineIds.join(',')}: 흐름 경로 아님)`
    const cells = g.cells.map((c) => {
      const name = g.rows === 1 ? `칸${c.c + 1}` : `칸[${c.r + 1},${c.c + 1}]`
      const inside = c.items
        .map((id) => {
          const o = board.get(id)
          if (!o) return id
          return o.kind === 'text' ? `${id} "${o.text}"` : `${id}(${KIND_KO[o.kind]})`
        })
        .join(', ')
      return `  ${name} 중심(${r(c.box.x + c.box.w / 2)},${r(c.box.y + c.box.h / 2)}) 안: ${inside || '비어 있음'}`
    })
    return [head, ...cells].join('\n')
  })
}

function describeObjs(board: Board) {
  const gridLines = new Set(board.grids.flatMap((g) => g.lineIds))
  const lines = board.objs
    .filter((o) => !gridLines.has(o.id))
    .map((o) => {
        const b = o.bbox
        const rep = o.replaces ? ` [지운 ${o.replaces} 자리에 새로 씀]` : ''
        if (o.kind === 'box') return `${o.id} 상자 x${r(b.x)} y${r(b.y)} w${r(b.w)} h${r(b.h)}${rep}`
        if (o.kind === 'line' && o.pts) {
          const p = o.pts
          const m = p[Math.floor(p.length / 2)]
          const head = o.arrowEnd ? `화살표(머리 ${o.arrowEnd === 'end' ? '끝점' : '시작점'} 쪽)` : '선'
          return `${o.id} ${head} (${r(p[0].x)},${r(p[0].y)})→(${r(m.x)},${r(m.y)})→(${r(p[p.length - 1].x)},${r(p[p.length - 1].y)}) (그린 순서)`
        }
        if (o.kind === 'text') return `${o.id} 글자 "${o.text}" 중심(${r(b.x + b.w / 2)},${r(b.y + b.h / 2)})${rep}`
        if (o.kind === 'dot') return `${o.id} 콕 찍은 점 (${r(b.x + b.w / 2)},${r(b.y + b.h / 2)})`
        return `${o.id} 손글씨/기호 x${r(b.x)} y${r(b.y)} w${r(b.w)} h${r(b.h)}${rep}`
      })
  return [...describeGrids(board), ...lines].join('\n') || '(아직 없음)'
}

function describeExtra(board: Board, now: number) {
  const out: string[] = []
  const er = board.erased.filter((e) => now - e.t < 60000).slice(-5)
  if (er.length)
    out.push(
      '지워진 객체(참조 금지):\n' +
        er
          .map(
            (e) =>
              `${e.id} ${KIND_KO[e.kind]}${e.text ? ' "' + e.text + '"' : ''} x${r(e.bbox.x)} y${r(e.bbox.y)} w${r(e.bbox.w)} h${r(e.bbox.h)} (${ago(now, e.t)}${e.rewritten ? ', 그 자리에 ' + e.rewritten + ' 새로 씀' : ''})`,
          )
          .join('\n'),
    )
  const tr = board.traces.filter((x) => now - x.t < 60000).slice(-3)
  if (tr.length)
    out.push(
      '가리킨 궤적(잉크 없음. move/flow의 along으로 쓸 수 있음):\n' +
        tr
          .map(
            (x) =>
              `${x.id} ${x.pts
                .filter((_, i) => i % 4 === 0 || i === x.pts.length - 1)
                .map((p) => `(${r(p.x)},${r(p.y)})`)
                .join('→')} ${x.dur.toFixed(1)}초, 지나간 객체 ${x.passes.join('→') || '없음'} (${ago(now, x.t)})`,
          )
          .join('\n'),
    )
  const ev = board.events.filter((e) => now - e.t < 45000).slice(-8)
  if (ev.length) out.push('최근 사건(오래된→최근):\n' + ev.map((e) => `- ${ago(now, e.t)} [${e.kind}] ${e.desc}`).join('\n'))
  return out.join('\n')
}

/** 요청마다 바뀌는 사용자 메시지 */
export function buildUserPrompt(ctx: PromptContext): string {
  const { board, engine, now } = ctx
  const page = board.page
  const pageText = page.text ? page.text.slice(0, 700) : ''
  return [
    `페이지 ${r(page.width)}×${r(page.height)}`,
    pageText ? `강의 자료 글자:\n${pageText}` : '',
    `객체:\n${describeObjs(board)}`,
    describeExtra(board, now),
    `지금 화면:\n${engine.describe()}`,
    `최근 발화(오래된→최근):\n${ctx.utter
      .slice(-5)
      .map((u) => `- (${ago(now, u.t)}) ${u.text}`)
      .join('\n') || '(없음)'}`,
    ctx.interim ? `지금 말하는 중: "${ctx.interim}"` : '',
    `이미 보여준 단계:\n${ctx.shown
      .slice(-6)
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n') || '(없음)'}`,
    `방금 일어난 일: ${ctx.trigger}`,
  ]
    .filter(Boolean)
    .join('\n')
}
