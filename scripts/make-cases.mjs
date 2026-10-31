// 합성 설명 사례 만들기: 손으로 그린 것 같은 필기 + 강의 대사 + 말마다 기대 상태.
// 사용: node scripts/make-cases.mjs   → cases/syn-*.json 생성(덮어씀)
// checks: { after: 말 번호, order?: "값 순서(왼→오)|허용 답", flows?: [흘러야 할 선 id], noFlow?: true }
import { writeFileSync } from 'node:fs'

let clock = 1000
let sid = 0
const jit = (v, a = 2.5) => v + (Math.random() - 0.5) * a

function stroke(pts, dur = 400, p = 0.6) {
  const t0 = clock
  clock += dur + 1500 // 획 사이 1.5초 (글자 묶기·화살표 판정이 사람처럼 되게)
  return { type: 'stroke', stroke: { id: 's' + ++sid, page: 1, points: pts.map(([x, y], i) => ({ x: jit(x), y: jit(y), p, t: t0 + (dur * i) / Math.max(1, pts.length - 1) })) } }
}
const seg = (x0, y0, x1, y1, n = 30) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n])
const rect = (x, y, w, h) => [...seg(x, y, x + w, y, 14), ...seg(x + w, y, x + w, y + h, 14), ...seg(x + w, y + h, x, y + h, 14), ...seg(x, y + h, x + 2, y + 4, 14)]
/** 숫자 자리에 쓰는 구불구불한 손글씨 (값은 사례의 read 로 준다) */
const squiggle = (cx, cy) => Array.from({ length: 31 }, (_, i) => {
  const t = i / 30
  return [cx + 20 * Math.sin(t * Math.PI * 3), cy - 45 + 90 * t]
})
const head = (x, y) => [[x - 22, y - 13], [x + 2, y], [x - 22, y + 13]]

/** 칸(상자) n개 + 각 칸에 손글씨. id: 상자 o1..on, 값 o(n+1)..o(2n) */
function array(values, x0 = 300, y0 = 260, w = 150) {
  sid = 0
  const events = [{ type: 'page', info: { page: 1, width: 1280, height: 720, text: '' } }]
  values.forEach((_, i) => events.push(stroke(rect(x0 + i * (w + 14), y0, w, 180), 700)))
  const read = {}
  values.forEach((v, i) => {
    events.push(stroke(squiggle(x0 + i * (w + 14) + w / 2, y0 + 90), 350))
    read['o' + (values.length + i + 1)] = String(v)
  })
  return { events, read, expect: { boxes: values.length, marks: values.length } }
}

const cases = []
const add = (name, note, built, speech, checks, text = '') => {
  built.events[0].info.text = text
  cases.push({ name, note, synthetic: true, expect: built.expect ?? {}, read: built.read, checks: checks.map(([after, c]) => ({ after, ...(typeof c === 'string' ? { order: c } : c) })), speech, events: built.events })
}

const BUBBLE = '배열 [5,3,8,1]. 인접한 두 값을 비교해 왼쪽이 크면 교환한다. 한 바퀴가 끝나면 가장 큰 값이 맨 뒤에 고정된다.'

add('syn-bubble-clean', '버블 정렬 세 바퀴를 깔끔한 말로 끝까지', array([5, 3, 8, 1]), [
  '자 여기 정렬이 안 된 배열이 있어요. 5, 3, 8, 1이죠.',
  '버블 정렬은 옆에 있는 두 값을 비교해요. 먼저 5와 3을 볼게요.',
  '5가 3보다 크니까 둘의 자리를 바꿔요.',
  '다음은 5와 8을 비교해요.',
  '5가 8보다 작으니까 그대로 둬요.',
  '이제 8과 1을 비교하면 8이 더 크죠. 그래서 8과 1을 바꿔요.',
  '이렇게 한 바퀴를 돌면 가장 큰 8이 맨 뒤로 가요.',
  '두 번째 바퀴에서 3과 5는 그대로 두고, 5와 1은 바꿔요.',
  '세 번째 바퀴에서 3과 1을 바꾸면 정렬이 끝나요.',
], [[0, '5 3 8 1'], [1, '5 3 8 1'], [2, '3 5 8 1'], [3, '3 5 8 1'], [4, '3 5 8 1'], [5, '3 5 1 8'], [6, '3 5 1 8'], [7, '3 1 5 8'], [8, '1 3 5 8']], BUBBLE)

add('syn-bubble-noisy', '버블 정렬, 음성 인식 오류와 잡담 섞임', array([5, 3, 8, 1]), [
  '자 여기 정렬 안 된 배열 오삼팔일 있죠',
  '옆에 거랑 비교할 건데 오랑 삼 먼저',
  '오가 더 크니까 자리 바꿔요',
  '다음 오랑 팔 비교',
  '팔이 크니까 그냥 둬요',
  '어 잠깐만 물 좀 마실게요',
  '팔이랑 일 비교하면 팔이 크니까 바꿔야죠',
  '이렇게 하면 제일 큰 게 맨 뒤로 가요',
], [[0, '5 3 8 1'], [1, '5 3 8 1'], [2, '3 5 8 1'], [3, '3 5 8 1'], [4, '3 5 8 1'], [5, '3 5 8 1'], [6, '3 5 1 8'], [7, '3 5 1 8']], BUBBLE)

add('syn-selection', '선택 정렬: 가장 작은 값을 찾아 앞과 교환', array([4, 2, 7, 1]), [
  '이번엔 선택 정렬이에요. 배열은 4, 2, 7, 1이에요.',
  '전체에서 가장 작은 값을 찾아볼게요. 1이 제일 작죠.',
  '가장 작은 1을 맨 앞의 4와 바꿔요.',
  '이제 두 번째 자리부터 다시 가장 작은 값을 찾아요. 2네요. 2는 이미 제자리라 그대로 둬요.',
  '남은 7과 4 중에서는 4가 작으니까 7과 4를 바꿔요.',
], [[0, '4 2 7 1'], [1, '4 2 7 1'], [2, '1 2 7 4'], [3, '1 2 7 4'], [4, '1 2 4 7']], '선택 정렬: 남은 값 중 가장 작은 값을 찾아 맨 앞과 교환한다.')

add('syn-insertion', '삽입 정렬: 끼워 넣으면 나머지가 밀림 (여러 개 동시 이동)', array([3, 1, 2], 380), [
  '삽입 정렬을 해볼게요. 3, 1, 2가 있어요.',
  '1을 꺼내서 3 앞에 끼워 넣어요. 그러면 3은 한 칸 뒤로 밀려요.',
  '다음은 2예요. 2는 3보다 작고 1보다 크니까 1과 3 사이에 들어가요.',
], [[0, '3 1 2'], [1, '1 3 2'], [2, '1 2 3']], '삽입 정렬: 값을 하나씩 꺼내 앞쪽 정렬된 부분의 알맞은 자리에 끼워 넣는다.')

add('syn-rotate', '회전: 맨 뒤 값을 맨 앞으로, 나머지는 한 칸씩 뒤로', array([5, 3, 8, 1]), [
  '이 배열에서 맨 뒤에 있는 1을 맨 앞으로 옮겨볼게요. 나머지는 한 칸씩 뒤로 밀려요.',
], [[0, '1 5 3 8']], '')

add('syn-explain-only', '설명만: 움직이면 안 됨 (앞질러 가기 오탐 확인)', array([5, 3, 8, 1]), [
  '이 배열은 아직 정렬되지 않았어요.',
  '정렬이 되면 작은 값부터 순서대로 놓이겠죠.',
  '오늘은 버블 정렬로 이걸 정렬해 볼 거예요. 시작하기 전에 질문 있나요?',
  '없으면 다음 슬라이드 먼저 보고 올게요.',
], [[0, '5 3 8 1'], [1, '5 3 8 1'], [2, '5 3 8 1'], [3, '5 3 8 1']], BUBBLE)

{
  // 변수 교환: 상자 a(o1), b(o2), 값 3(o3), 7(o4)
  sid = 0
  const events = [{ type: 'page', info: { page: 1, width: 1280, height: 720, text: '' } }]
  events.push(stroke(rect(360, 260, 180, 180), 700), stroke(rect(740, 260, 180, 180), 700))
  events.push(stroke(squiggle(450, 350), 350), stroke(squiggle(830, 350), 350))
  events.push({ type: 'text', page: 1, id: 'xa', text: 'a', x: 440, y: 230, t: (clock += 1500) }, { type: 'text', page: 1, id: 'xb', text: 'b', x: 820, y: 230, t: (clock += 1500) })
  add('syn-swap-vars', '변수 a, b 값 교환 (배열 아님)', { events, read: { o3: '3', o4: '7' }, expect: { boxes: 2, marks: 2 } }, [
    '변수 a에는 3, b에는 7이 들어 있어요.',
    '두 값을 바꾸고 싶어요. 그냥 a에 b를 넣으면 3이 사라지니까 임시 변수가 필요해요.',
    '임시 변수를 거쳐서 바꾸면 결국 a는 7, b는 3이 돼요.',
  ], [[0, '3 7'], [1, '3 7'], [2, '7 3']], '두 변수의 값을 교환하려면 임시 변수가 필요하다.')
}

{
  // TCP 흐름: 송신자 상자 o1, 수신자 상자 o2, 화살표 o3
  sid = 0
  const events = [{ type: 'page', info: { page: 1, width: 1280, height: 720, text: '' } }]
  events.push(stroke(rect(110, 250, 200, 140), 700), stroke(rect(970, 250, 200, 140), 700))
  events.push(stroke(seg(320, 320, 955, 320, 40), 380, 0.4))
  clock -= 1300 // 화살표 머리는 선 바로 뒤에
  events.push(stroke(head(957, 320), 150, 0.5))
  events.push({ type: 'text', page: 1, id: 'xs', text: '송신자', x: 160, y: 320, t: (clock += 1500) }, { type: 'text', page: 1, id: 'xr', text: '수신자', x: 1020, y: 320, t: (clock += 1500) })
  add('syn-tcp-flow', 'TCP: 흐름 시작과 멈춤 (순서가 아니라 흐름 채점)', { events, read: {}, expect: { boxes: 2, arrows: 1 } }, [
    '왼쪽이 송신자, 오른쪽이 수신자예요.',
    '송신자가 수신자에게 패킷을 이렇게 계속 보내요.',
    '그런데 중간에 네트워크가 끊기면 패킷이 더 이상 안 가요.',
  ], [[1, { flows: ['o3'] }], [2, { noFlow: true }]], '송신자→네트워크→수신자로 패킷이 흐른다.')
}

for (const c of cases) writeFileSync(`cases/${c.name}.json`, JSON.stringify(c) + '\n')
console.log(cases.map((c) => `${c.name}: 말 ${c.speech.length}개, 확인 ${c.checks.length}개`).join('\n'))
