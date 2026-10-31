# 필기·발화 인식과 애니메이션 실행 분리 설계

작성일: 2026-11-01

설계 브랜치: `codex/recognition-design`

상태: 구현 전 검토용 제안

실행 계획: [recognition-implementation-plan.md](recognition-implementation-plan.md)

## 1. 해결하려는 문제와 결정

칠판의 원본 획, 그 획에 대한 해석, 현재 설명의 대상, 실제 실행 상태를 분리한다.
인식 결과는 수정할 수 있는 가설로 저장하고, 애니메이션은 확정된 발화와 검증된 대상에 근거해 실행한다.

핵심 결정은 다음과 같다.

1. 기하 규칙은 후보를 제안한다. 숫자·상자·문자·그림의 최종 구분을 독점하지 않는다.
2. 인식은 객체의 종류·묶음·관계를 수정할 수 있다. OCR 문자열 하나로 그림을 설명하지 않는다.
3. 인식 요청과 발화 처리 요청을 분리하고, 새 획이 들어왔다고 모든 요청을 취소하지 않는다.
4. 발화는 의미와 대상을 먼저 해석한다. 실행 검증은 객체·버전·권한·배치를 검사한다.
5. 중간 발화는 미리 보기, 확정 발화는 실행 단위다. 완성된 단계 전체를 검사한 뒤 반영한다.
6. 인식·의도·계획·실행을 각각 측정하고, 원본 입력부터 끝까지 재현하는 평가를 추가한다.

공통 경로는 **비동기 시각 인식 + 확정 발화당 의미 해석 한 번 + 로컬 동작 변환**이다.
매 발화마다 인식·의도·계획 모델을 세 번 직렬 호출하는 구조를 만들지 않는다.
현재 모델 연결을 재사용하며, 모델 교체 효과는 같은 검증 세트에서 별도 실험한다.

## 2. 설계 기준과 관측 범위

워크트리는 커밋 `411fd5da740c7058a3d2bce251b7b33428b5baac`에서 만들었다.
진단에는 원래 작업 폴더의 미커밋 변경도 읽었다. 이 워크트리에 그 변경을 복사하지 않았다.
따라서 여기의 소스는 최신 작업 폴더와 같지 않으며, 이 문서를 근거로 구현하기 전에 통합 기준을 먼저 확정해야 한다.

원래 작업 폴더: `/Users/hurdoo/coding/projects/ilsabullan-professor`

설계 워크트리: `/Users/hurdoo/coding/worktrees/ilsabullan-professor-recognition-design`

| 관측 | 확인된 원인 또는 제약 | 설계에 미치는 영향 |
| --- | --- | --- |
| 01:58 정렬 실측에서 숫자 8의 객체가 box로 분류됨 | 숫자 목록과 판독 저장이 mark/text 중심이다 | 모든 획을 재분류할 수 있어야 한다 |
| 01:56 세포 그림에서 도형 일부를 문자로 판독함 | 손글씨/기호가 같은 mark이고 read 문자열이 후속 사실로 쓰인다 | 문자와 도형 해석, 객체 묶음, 의미 역할을 분리한다 |
| 판독값은 획이 바뀌지 않으면 덮어쓰지 않음 | 한번의 오인식이 유지되고 auto 이미지 전송도 멈출 수 있다 | 판독 상태·근거·재검토 경로를 둔다 |
| 같은 실측의 요청 25건 중 13건이 중단됨 | 새 입력이 기존 요청을 전역 취소한다 | 변경 영역 병합과 의존성 기반 무효화가 필요하다 |
| 실행 허용에 한국어 키워드 정규식이 사용됨 | 의미 해석과 허용 판정이 다른 기준을 쓴다 | 의미 결정과 구조 검증의 책임을 나눈다 |
| 최신 02:08 세션에 request-start/request 기록이 없음 | 호출 이전 문제일 가능성이 있으나 정확한 원인은 해당 로그만으로 불명확하다 | 입력별 처리 상태와 연결 상태 전이를 기록한다 |
| 현재 평가가 손글씨 정답 라벨을 공급함 | OCR과 실제 마이크 인식은 평가 범위 밖이다 | 기존 평가는 구성요소 평가로 남기고 전체 평가를 추가한다 |

위 사례는 관측된 실패를 설명한다. 실패율 전체나 특정 모델의 일반 성능을 뜻하지 않는다.
원본 로그·이미지·음성 전사·인증 정보는 이 설계 브랜치에 복사하지 않는다.
기존 `docs/CALIBRATION.md`의 원자적 단계, 중복 실행 방지, 페이지 무효화, 로그 저장 확인 요구를 유지한다.

## 3. 데이터 흐름과 책임

~~~mermaid
flowchart TD
  Ink[InkBus 입력] --> Raw[원본 획과 글자 저장]
  Raw --> Geo[기하 후보와 변경 영역]
  Geo --> PS[인식 스케줄러]
  PS --> Vision[시각 인식]
  Vision --> Scene[수정 가능한 장면 상태]
  Raw --> Scene
  Speech[중간·확정 발화] --> Utter[발화 상태]
  Utter --> Resolve[의미와 대상 해석]
  Scene --> Resolve
  Render[실행 위치와 커밋 기록] --> Resolve
  Resolve --> Plan[로컬 동작 계획 변환]
  Plan --> Validate[버전·대상·단계 검증]
  Validate --> Engine[기존 Engine과 Player]
  Engine --> Render
~~~

| 구성요소 | 소유하는 상태 | 수행하지 않는 일 |
| --- | --- | --- |
| 원본 저장소 | 획 ID, 점, 글자 도구 입력, 페이지 epoch, 원본 revision | 모델 해석으로 원본을 덮어쓰기 |
| 장면 저장소 SceneStore | 획의 묶음, 종류 후보, 판독값, 역할, 관계, 해석 revision | 애니메이션 위치 변경 |
| 발화 저장소 | 중간/확정 원문, 수정 후보, 발화 ID, 수신 시각 | 틀린 전사를 조용히 정답으로 교체 |
| 대상 해석기 IntentResolver | 현재 발화의 의미, 근거, 특정된 대상, 보류 사유 | 원본 획 삭제, 직접 엔진 실행 |
| 계획기 ActionPlanner | 의미 결정을 실행 가능한 완성 단계로 변환 | 말하지 않은 다음 강의 단계 추측 |
| 실행기 | 현재 화면 위치, 확정 도착점, 효과, 실행 이력 | OCR 결과나 발화 의미 결정 |

상태는 기존 브라우저 메모리와 개발용 로그를 사용한다. 새 데이터베이스는 요구하지 않는다.
`Pipeline`은 이 구성요소를 연결하는 조정자로 줄이고, 외부의 `InkBus` 연결과 `say()` 진입점은 유지한다.

## 4. 먼저 고정할 데이터 계약

아래 타입은 계약 초안이다. 구현 시 런타임 검증과 함께 정의한다.
모델 응답에서 오는 ID·버전·근거는 모두 검증 대상이다.

~~~ts
import type { Op } from '../src/animation/ops'

type EntityRef = { id: string; revision: number }
type LocalRef = { localId: string }
type ActionRef = EntityRef | LocalRef

type Interpretation = {
  kind: 'unknown' | 'number' | 'text' | 'shape' | 'connector' | 'annotation'
  value?: string
  role?: string
  state: 'candidate' | 'accepted' | 'disputed'
  basis: 'geometry' | 'vision' | 'typed' | 'correction'
  evidenceId: string
}

type EntitySource = { strokeIds: string[]; textId?: string }
type SceneEntity = {
  id: string
  revision: number
  source: EntitySource
  grouping: 'provisional' | 'accepted'
  interpretation: Interpretation
}

type SceneRelation = {
  id: string
  revision: number
  kind: 'contains' | 'connects' | 'annotation-of' | 'same-row'
  from: EntityRef
  to: EntityRef
  state: 'candidate' | 'accepted' | 'disputed'
}

type PerceptionChange =
  | { kind: 'interpret'; target: EntityRef; proposed: Interpretation }
  | {
      kind: 'regroup'
      replaces: EntityRef[]
      entities: { localId: string; source: EntitySource; proposed: Interpretation }[]
    }
  | {
      kind: 'relate'
      relation: { kind: SceneRelation['kind']; from: ActionRef; to: ActionRef }
    }
  | { kind: 'remove-relation'; target: { id: string; revision: number } }

type PerceptionPatch = {
  requestId: string
  pageEpoch: number
  sourceRefs: { id: string; revision: number; bindingRevision: number }[]
  regionRef: { id: string; revision: number }
  changes: PerceptionChange[]
}

type Anchor =
  | { kind: 'entity'; target: ActionRef }
  | { kind: 'point'; x: number; y: number }

type SemanticEffect =
  | { kind: 'highlight'; targets: ActionRef[] }
  | { kind: 'swap'; a: ActionRef; b: ActionRef }
  | { kind: 'move-to'; target: ActionRef; destination: Anchor }
  | { kind: 'flow'; path: ActionRef; direction: 'forward' | 'reverse' }
  | { kind: 'stop'; path: ActionRef }
  | {
      kind: 'style'; target: ActionRef
      style: { color?: string; scale?: number; opacity?: number; label?: string }
    }
  | {
      kind: 'spawn'; localId: string
      shape: 'dot' | 'circle' | 'box' | 'label'; at: Anchor; text?: string
    }
  | {
      kind: 'arrange'; container: EntityRef; items: EntityRef[]
      order: 'ascending' | 'descending' | EntityRef[]
    }

type SpeechDecision = {
  utteranceId: string
  pageEpoch: number
  kind: 'comparison' | 'state-change' | 'correction' | 'irrelevant' | 'ambiguous'
  targets: EntityRef[]
  relationRefs: { id: string; revision: number }[]
  evidence: { eventId: string; start: number; end: number }[]
  effects: SemanticEffect[]
  corrections?: { target: EntityRef; proposed: Interpretation }[]
  reason?: string
}

type ActionPlan = {
  id: string
  utteranceId: string
  pageEpoch: number
  readSet: EntityRef[]
  relationReadSet: { id: string; revision: number }[]
  layoutReadSet: { id: string; revision: number }[]
  regionReadSet: { id: string; revision: number }[]
  writeSet: string[]
  steps: { id: string; ops: Op[]; caption: string }[]
  expiresAt: number
}
~~~

이 타입은 모델 출력 문자열을 그대로 신뢰하는 계약이 아니다.
request ID, page epoch, 입력 revision, utterance ID는 호출자가 보관한 값으로 결합한다.
모델의 proposed 해석은 candidate로 받고, accepted/disputed 전이는 애플리케이션이 검증 후 결정한다.
LocalRef는 응답 안의 임시 이름이며 패치/계획 검증 후 앱이 실제 ID를 발급한다.
regroup의 새 객체들은 replaces가 가진 원본의 정확한 분할이어야 하고, 없는 획을 추가할 수 없다.
의미 결정의 kind와 effects 조합도 검사한다. comparison에는 highlight만,
correction에는 corrections만, irrelevant/ambiguous에는 실행 효과를 허용하지 않는다.
현재 실행에서 생성된 객체도 EntityRef로 조회하되 원본 entity와 별도의 ID 공간을 쓴다.

시각 인식 응답은 PerceptionPatch 한 개, 의미 해석 응답은 SpeechDecision 한 개의 완성된 JSON으로 받는다.
전송은 스트리밍을 사용해도 전체 객체의 스키마 검증 전에는 상태를 바꾸지 않는다.
동작 NDJSON의 부분 도착으로 판독과 이동을 함께 적용하던 경로는 이 두 응답에서 사용하지 않는다.

### 4.1 객체의 정체성과 원본

- 원본 stroke ID와 좌표는 불변이고 지움 이벤트는 삭제 revision을 남긴다.
- 기존 `Board.classify()`와 가까운 획 묶기는 초기 후보다. 상자·선으로 분류된 획도 인식 대상에 포함한다.
- 모델은 제공된 stroke/글자 ID만 묶을 수 있다. 없는 획을 만들어낼 수 없다.
- 같은 레벨의 실행 가능한 객체 둘이 같은 획을 소유할 수 없다.
- 세포와 내부 염색체처럼 포함 관계인 객체는 화면 영역이 겹칠 수 있다.
  상위 개념의 묶음은 관계로 표현하고 획을 중복 소유하지 않는다.
- 종류·판독값 갱신은 같은 entity ID의 revision을 올린다.
  실제 merge/split은 새 ID를 발행하고 기존 ID를 폐기한다.
  예전 계획의 참조를 새 ID로 조용히 바꾸지 않고 대상 해석을 다시 한다.
- merge/split 패치는 전체 획 소유권과 관계를 한 번에 검사하고 원자적으로 반영한다.

### 4.2 수정 가능한 판독과 관계

숫자 값, 글자 내용, 도형 종류, 의미 역할을 각각 기록한다.
염색체의 역할이 붙어도 OCR 글자 값으로 “염색체”를 넣지 않는다.
문맥으로 추정한 역할은 그 근거가 발화인지 시각 관측인지 구분한다.

재검토 계기는 획 수정, 종류/값과 문맥의 충돌, 관련 영역의 새 획,
사용자의 명시적 정정, 해당 영역을 쓰는 발화의 대상 해석 실패다.
모델의 확신 수치 하나만으로 accepted를 정하지 않는다.
모순 없는 시각 근거, 원본 버전, 그룹 일관성을 함께 검사하고 수용 기준은 평가로 보정한다.

글자 도구 입력과 사용자가 확정한 수정은 높은 우선순위를 갖는다.
서로 다른 판독이 충돌하면 disputed로 전환해 재관측하며,
증거 변화 없이 같은 후보를 무한히 재질의하지 않는다.
미확정 종류에는 모양 강조를 허용할 수 있지만 숫자 정렬에는 accepted 숫자만 쓴다.
모든 연산에 OCR을 요구하지 않는다. 도형 이동은 검증된 그룹과 역할로 처리할 수 있다.

관계도 revision을 갖는다. 새 화살표 머리, 경로의 지움, 컨테이너 변경은 관련 연결을 다시 검사한다.
배열의 순서는 원본 x좌표가 아니라 실행기의 확정 도착점에서 계산한다.
같은 행·컨테이너가 특정되지 않은 객체를 페이지 전체에서 한 배열로 합치지 않는다.

### 4.3 정정 동선

첫 구현의 개발 패널에서 현재 보이는 객체를 선택해 종류·판독값을 고칠 수 있게 한다.
선택은 실제 화면 좌표에서 처리하고 제품 화면에는 내부 ID/revision을 노출하지 않는다.
명확한 대상에 대한 정정 발화도 correction 결정으로 같은 갱신 경로를 사용한다.
대상이 모호하면 후보를 일시 강조하고 보류하며, 매 발화마다 확인 대화창을 띄우지 않는다.
사용자 수정은 원본 획을 바꾸지 않고 interpretation과 관련 계획만 갱신한다.

## 5. 시각 인식 요청

### 5.1 관측 이미지

현재의 전체 화면 JPEG에는 애니메이션 효과와 객체 ID가 함께 들어간다.
새 인식 입력은 다음을 구분한다.

- **원본 관측:** 관련 획과 주변 문맥을 원본 해상도에 가깝게 자른 이미지.
  효과·자막·AI가 생성한 글자·펄스는 포함하지 않는다.
- **대응 정보:** crop→페이지 좌표 변환, stroke ID, 기하 후보,
  필요하면 ID를 여백에 표시한 보조 이미지.
- **현재 배치:** 원본 객체의 현재 위치/변환을 별도의 구조 데이터로 전달한다.
  인식 이미지의 좌표와 애니메이션 후 좌표를 섞지 않는다.

최초에는 페이지 개요와 변경 영역 crop을 함께 제공하고,
반복 인식은 해당 영역과 필요한 이웃을 보낸다.
640px 전체 이미지 하나에 모든 판독을 맡기지 않는다.
crop 크기·여백·개요 해상도는 태블릿 실제 필기 평가로 정한다.
PDF 원본 픽셀은 현재 PageInfo에 없으므로 첫 구현의 전제에 넣지 않는다.

### 5.2 병합, 만료와 예산

아래 시간은 초기 실험값이며 성능 보장이 아니다.

- 획 완료 후 같은 영역에서 300ms 동안 입력이 없으면 인식을 예약한다.
- 계속 쓰면 변경 영역을 합치되 최대 1.2초마다 완료된 획의 스냅샷을 후보 인식한다.
- 페이지당 인식 요청은 하나만 진행하고, 진행 중 입력은 최신 변경 영역 한 묶음으로 남긴다.
- 추가 획이 왔다는 이유만으로 네트워크 요청을 매번 취소하지 않는다.
  응답은 그 응답이 실제 본 영역과 원본 revision에 대해서만 적용한다.
- 요청 영역 안이나 인접 문맥에 새 획이 생기면 region revision이 바뀐다.
  기존 stroke가 그대로여도 불완전한 그림을 본 응답을 최종 판독으로 적용하지 않는다.
- 무관한 영역의 새 획 때문에 유효한 판독까지 버리지 않는다.
- 첫 구현은 완료된 stroke 이벤트로 동작한다. 현재 계약에 없는 pen-down 신호에 의존하지 않는다.
- 인식과 의미 해석은 독립적으로 최대 하나씩 진행한다. 전체 모델 요청 동시성의 초기 상한은 2다.
- 인식은 6초, 의미 해석은 4초를 초기 timeout으로 둔다.
  동일 입력의 자동 재관측/수정 시도는 최대 한 번이며 이후에는 보류 사유를 표시한다.

취소 조건은 페이지 epoch 변경, 대상 원본 삭제, 명시적 중지, timeout이다.
실행 중 관련 영역이 바뀐 응답은 적용하지 않고 최신 영역을 한 번 후속 처리한다.
지속 필기에서는 후보 인식은 계속하되 안정되지 않은 그룹의 상태 변경은 기다린다.

## 6. 발화·지시 대상과 동작

### 6.1 음성 입력의 불확실성 보존

브라우저 인식 원문과 보정 후보를 함께 보존한다.
현재 어댑터가 첫 transcript만 쓰는 부분은 후보/확신 정보가 실제 제공되는 범위에서 확장한다.
후보를 제공하지 않는 브라우저에서 대안을 만들어 기록하지 않는다.

중간 발화는 같은 utterance의 revision이다. final에서 실행 ID를 확정한다.
빈 final은 인식 진단으로 남기고, 직전 interim을 임의로 확정해 실행하지 않는다.
장면에 있는 값·이름으로 전사를 보정할 수 있으나 원문, 후보, 보정 근거를 구분한다.
부정·질문·가정·미래 설명도 의미 해석에 포함한다.

첫 구현은 현재 Web Speech 입력을 유지한다.
실제 말과 전사의 차이를 별도 평가한 뒤 음성 엔진 변경의 필요성을 결정한다.
실제 음성 평가는 동의해 수집한 평가용 녹음과 사람이 확인한 전사를 사용한다.
음성이 없는 과거 로그로 음성 정확도를 계산하지 않는다.

### 6.2 대상 해석 순서

1. 발화의 명시적 값·이름·순서와 해당 컨테이너를 찾는다.
2. 해당 발화 시간대의 의도적인 가리키기·강조와 연결한다.
3. “둘/이것/여기”는 최근의 **성공적으로 특정된** 대상 문맥을 사용한다.
4. 같은 숫자가 여러 개이거나 최신 비교가 모호하면 보류한다.
   모호한 새 비교를 건너뛰고 예전 비교 쌍을 재사용하지 않는다.

대상 문맥에는 entity revision, 근거 utterance ID, 가리키기 ID,
컨테이너, 마지막 사용 시각을 저장한다.
시간 만료만으로 관리하지 않고 새 비교, 그룹 변경, 페이지 변경 시 무효화한다.
가리키기는 현재 화면 위치로 hit-test하고, 긴 궤적 자체와 특정 객체 선택을 구분한다.

발화가 들어왔을 때 인식이 미완료면 awaiting-scene으로 보관한다.
관련 인식이 끝나면 **같은 final 원문으로 대상을 다시 해석한 뒤** 실행한다.
인식 전에 만든 빈 targets를 인식 이후에도 그대로 쓰는 경합을 없앤다.
첫 실행 시작의 대기 기한은 final 수신 후 5초이며, 기한이 지나면 pending을 종료하고 명시적 보류를 남긴다.
계획이 시작된 후에는 각 단계의 버전 검증을 유지하고, 이 최초 대기 기한으로 중간 단계를 끊지 않는다.
새 입력 때문에 오래된 설명이 뒤늦게 재생되지 않도록 더 최신의 충돌 발화도 검사한다.

### 6.3 의미 결정과 로컬 계획

의미 해석은 comparison/state-change/correction/irrelevant/ambiguous와,
입력 근거·대상·필요한 의미 동작을 반환한다.
공통 의미 동작은 highlight, swap, move-to, flow, stop, style, spawn, arrange다.
장면 종류별 전체 교육 과정을 미리 실행하는 도메인 스크립트는 추가하지 않는다.

- 비교는 highlight로 변환한다.
- swap은 같은 단계의 move 두 개로 변환한다.
- move-to는 확인된 대상/경로/도착 앵커를 사용한다.
- flow는 관계와 방향이 특정된 경로에만 적용한다.
- arrange는 명시적으로 결과를 요구했고 컨테이너와 원소가 확인된 경우에 쓴다.
- 생성 객체는 원본 잉크와 별도 namespace를 쓰며, 다음 계획에서 참조할 수 있게 실행 상태에 남긴다.
- 지원할 수 없는 의미 동작은 원인을 남기고 보류한다.

의미 해석 입력에는 final 원문/후보, 현재 장면과 관계, 대상 문맥,
관련 대상의 최근 의미 결정과 실제 커밋 이력을 포함한다.
강의 자료는 의미를 이해하는 문맥이며 실제로 설명한 사건의 근거로 쓰지 않는다.
짧은 자막 목록을 실제 실행 이력 대신 사용하지 않는다.

구조화된 의미 동작은 모델의 같은 응답에서 받는다.
로컬 계획기는 이를 기존 Op로 컴파일하고 수치·경계·원자성·대상 버전을 검증한다.
일반적인 숫자 비교·교환·정렬은 로컬 계산으로 일관성을 확인한다.
자유로운 도형 이동은 같은 응답의 도착 앵커 제안을 검사하되 다음 강의 내용을 추측해 채우지 않는다.

키워드 정규식은 후보 추출과 진단에만 남긴다.
단어가 목록에 없다는 이유로 유효한 의미 결정을 막는 최종 게이트로 쓰지 않는다.
반대로 모델이 근거 span을 반환했다는 사실만으로 의미가 맞다고 보장할 수도 없다.
이 부분의 오작동은 부정·가정·질문·잡담을 포함한 검증 세트로 측정한다.

### 6.4 미리 보기와 확정 실행

초기 기본값은 final당 의미 해석 한 번이다.
interim마다 모델을 부르는 동작은 끄고,
이미 특정된 대상에 한해 100ms 이내의 일시적인 시각 강조를 목표로 한다.
원래 색과 분리된 일시 효과를 사용하며 swap·move·spawn·지속 flow를 미리 실행하지 않는다.

새 final은 기존 final을 무조건 취소하지 않는다.
서로 다른 대상이면 순서를 보존하고, 같은 대상에 대한 후속 설명이면 이전 커밋 이후 상태를 사용한다.
명시적 정정·중지는 관련 미실행 단계만 취소한다.
이미 시작된 원자적 단계는 완료한 뒤 정정을 적용하며, 자동으로 과거 상태를 추측해 되돌리지 않는다.

## 7. 원자적 실행과 화면 연결

### 7.1 검증 규칙

1. 응답과 계획의 페이지 epoch가 현재와 같아야 한다.
2. 원본·그룹·해석·관계·관련 배치 revision이 계획의 read set과 같아야 한다.
3. 대상과 경로가 존재하며, 해당 발화의 결정 범위에 있어야 한다.
4. 완성된 JSON 단계 전체가 유효해야 한다. 교환 한쪽만 실행하지 않는다.
5. 컨테이너별 공간 제약을 검사한다.
   숫자 슬롯의 충돌은 막지만 세포 내부 포함이나 도형 연결의 겹침은 허용한다.
6. 같은 plan ID/step ID는 재전송돼도 한 번만 커밋한다.
   새로운 utterance의 의도적인 재교환은 새 실행으로 허용한다.
7. 각 단계 시작 전에 재검증하고, 실패하면 그 단계와 뒤의 의존 단계를 중단한다.

관련 배치만 read set에 포함한다.
목적지의 빈 공간을 읽는 계획은 그 영역의 점유 revision도 포함해 새 객체와의 충돌을 검사한다.
전역 scene revision은 로그 순서에 쓰고, 무관한 새 획 때문에 계획을 무효화하는 기준으로 쓰지 않는다.
실행 단계가 바꾼 revision은 다음 단계의 기대 상태에 반영한다.

### 7.2 기존 엔진과의 연결

원본 저장소가 가진 stroke를 SceneStore의 실행 가능한 leaf entity별로 투영해
기존 BoardObj 형태의 **RenderBoard 뷰**를 만든다.
Engine이 필요로 하는 get/objs/page/경로 조회 계약을 작은 인터페이스로 분리하고,
현재의 Engine/Player/Op/AnimationOverlay와 hideStrokes 방식을 재사용한다.

RenderBoard의 bbox는 원본 좌표, Engine의 transform은 현재 화면 위치다.
새 원본 저장소, SceneStore, Engine이 각자 현재 위치를 따로 수정하지 않게 한다.
부모 개념은 leaf 집합으로 동작을 확장하고 같은 획을 두 번 숨기거나 그리지 않는다.

이동 중인 entity의 merge/split은 단계 종료까지 보류한다.
서로 다른 transform을 가진 객체를 합치는 제안은 자동 반영하지 않고 보류한다.
원본 삭제/편집으로 진행 단계를 강제로 중단할 때는:
변경되지 않은 참여자는 이미 커밋된 도착점에 정착하고,
변경된 원본의 takeover를 해제해 편집 결과를 노출한다.
그 뒤의 계획과 관련 대상 문맥을 무효화하고 interruption을 기록한다.

편집기의 가리키기·지우기 hit-test는 RenderBoard와 현재 transform을 사용해 원본 stroke ID로 역매핑한다.
새 필기가 이동한 객체에 덧붙여졌는지도 현재 표시 위치 기준으로 검사한다.
원본 이벤트의 점은 보존하고, 덧필기를 기존 객체에 붙일 때 입력 시점의 역변환을 별도 stroke binding으로 기록한다.
RenderBoard는 binding을 적용한 기준 좌표에서 bbox를 계산하고, Engine은 그 위에 현재 transform을 적용한다.
binding이 바뀌면 해당 source/entity revision을 올린다. 겹친 객체 중 대상이 모호하면 자동으로 붙이지 않는다.
이 역매핑 없이 화면에서 옮겨진 객체를 원래 위치로만 찾는 문제를 남기지 않는다.
page/clear는 전체 epoch를 바꾸고 모든 인식·발화·계획·효과를 무효화한다.

## 8. 연결 복구와 관측 가능성

/api/status의 키 존재 여부, 프록시 접근 가능 여부, 실제 제공자 호출 결과를 구분한다.
키가 있다는 응답만으로 모델 호출 성공을 표시하지 않는다.
상태는 checking/available/degraded/locked/missing-key를 구분하고 전이 이유를 남긴다.

일시적인 초기화/네트워크 실패는 1·2·5·10초 후 제한적으로 재확인한다.
이후에는 브라우저 online/visibility 복귀와 사용자의 재시도로 상태를 확인한다.
403은 locked, 키 없음은 missing-key로 표시하며 같은 실패를 빠르게 반복하지 않는다.
재인증 뒤 상태 확인은 다시 수행하되, 기한이 지난 발화는 자동 재생하지 않는다.

입력별로 다음 상태 중 어디에 있는지 알 수 있어야 한다.

`received → batched → recognizing/awaiting-scene → resolving → planned → committed`

종료는 no-action/ambiguous/unsupported/stale/cancelled/timeout/connection-error 등으로 구분한다.
입력이 AI 준비 상태 때문에 버려져도 received와 종료 이유는 남긴다.
진단 패널에는 “AI 요청 안 됨”, “읽는 중”, “대상 불명확”, “검증에서 보류”를 구분해 표시한다.

공통 로그 필드는 event ID, parent event ID, page epoch, utterance ID,
perception request ID, entity/region revision, plan/step ID, 단조 시각, 종료 이유다.
기존 request-start/update/request, applied/state/rejected 및 저장 ACK 계약과 연결한다.
객체의 accepted 전환과 정정 전후도 구조 이벤트로 기록해 실패 단계를 재현할 수 있게 한다.

## 9. 평가와 수용 기준

### 9.1 평가를 네 층으로 분리

| 평가 | 입력 | 검사 |
| --- | --- | --- |
| 시각 인식 | 실제 획 시간 순서와 원본 이미지, 정답 주입 없음 | 숫자/그림 구분, 값, 그룹, 관계, 정정 성공 |
| 발화·의도 | 고정 장면과 전사 후보, 별도 음성 평가 시 녹음 | 대상 ID, 비교/실행/보류, 부정·가정·지시어 |
| 계획·실행 | 확정 의미 결정과 장면 | 원자성, 재실행, 버전 경합, 위치, 올바른 경로 |
| 전체 시간 재현 | 실제 간격의 획·interim·final 또는 평가 음성 | 잘못된 실행, 필요한 실행 누락, 지연, 전체 사례 성공 |

현재 정답 라벨 주입 평가는 계획·실행 쪽 비교 기준으로 남긴다.
새 전체 평가는 브라우저 또는 같은 이미지 생성 경로를 가진 평가 어댑터에서 수행한다.
headless라 이미지를 끄는 기존 경로를 전체 평가로 부르지 않는다.

실제 간격 재생 중에 매 발화마다 완료를 기다리지 않는다.
교환했다가 원상 복귀한 것도 실행 이력에서 잡고,
배열 최종 순서가 우연히 맞는 것만으로 성공 처리하지 않는다.
보류가 정답인 샘플과 실행이 필요한 샘플을 함께 넣어 무조건 보류하는 구현도 실패시킨다.

### 9.2 필수 회귀 시나리오

- 크게 쓴 8이 box 후보여도 number로 정정되고 정렬 원소에 포함된다.
- 여러 획의 X 도형이 한 염색체 객체가 되고 OCR 문자로 고정되지 않는다.
- 밑줄과 화살표, 글자와 도형을 구분하고 새 획으로 판독을 갱신한다.
- 인식 완료 전에 발화가 들어와도 인식 후 같은 발화의 대상이 재해석된다.
- “비교만”, 부정, 가정, 중간 발화, 잡담에서 상태 변경이 일어나지 않는다.
- 중복 숫자, 불명확한 새 비교, 지시어, 여러 컨테이너를 처리한다.
- 새 획은 진행 요청을 전역 취소하지 않고, 관련 영역의 오래된 응답은 적용하지 않는다.
- 같은 응답 재전송은 한 번 실행하고, 새 발화의 같은 교환은 다시 실행한다.
- 페이지 변경, 대상 지움, merge/split, 이동 중 편집에서 예전 계획이 실행되지 않는다.
- 여러 경로 중 선택한 경로만 흐르고, 그림의 정상 포함 관계는 충돌로 거부하지 않는다.
- 초기 연결 실패 후 복구해도 만료된 발화를 갑자기 실행하지 않는다.

### 9.3 출시 전 목표와 측정 의미

목표값은 첫 전체 기준 측정 후 조정할 제안이며 현재 달성한 수치가 아니다.

- 결정적 회귀 테스트: 모두 통과. 부분 교환·중복 커밋·이전 페이지 실행은 0건.
- 검증용 데이터: 정렬·다중 경로·도형 설명 각 10세션 이상,
  보정에 사용하지 않은 필기자 3명 이상을 포함해 별도로 확보한다.
- 잘못된 상태 변경: 평가 대상 전체에서 1% 이하를 목표로 하고 분자/분모를 함께 보고한다.
- 실행이 필요하고 근거가 충분한 입력의 올바른 완료: 90% 이상을 목표로 한다.
- 시각 인식은 숫자 정확 일치, 그룹 획 집합 일치, 관계 정확도, 정정 성공률을 따로 보고한다.
- 인식 준비 상태의 확정 발화→첫 올바른 실행 시작: p50 1초, p90 2.5초 이내를 목표로 한다.
- 시각 인식 대기 포함 지연은 별도로 보고하고 p90 4초를 초기 목표로 둔다.
- 자동 취소율, 불필요 호출 수, 세션별 토큰/비용, 보류율을 기존 구현과 같은 입력으로 비교한다.

사람이 검토한 목표 사건을 분모로 쓰고, 샘플 수·반복 횟수·전체 세션 성공률을 함께 표시한다.
음성이 없는 평가의 지연 시작점은 final 이벤트 수신이다.
사용자 체감 음성 종료→화면 지연과 혼용하지 않는다.
적은 표본의 0건 실패를 일반적인 0% 오류율로 주장하지 않는다.

## 10. 전환 전략과 남은 결정

전환은 관측/평가 → SceneStore 병행 관찰 → 시각 인식 → 의미/계획 → 엔진 연결 → 전체 검증 순서다.
각 단계의 체크리스트와 변경 파일은 [실행 계획](recognition-implementation-plan.md)에 둔다.
기존 경로와 새 경로를 설정으로 선택할 수 있게 하고, 병행 관찰 중에는 기존 경로만 화면을 구동한다.
새 경로 승격 시에는 하나의 실행기만 사용해 이중 실행을 막는다.

구현 전에 확정할 항목은 세 가지다.

1. 최신 미커밋 개선을 포함한 기준 커밋과 테스트 기준선.
2. 이 문서의 인식 패치/의미 동작 계약과 Engine 최소 조회 인터페이스의 런타임 검증 구현.
3. 평가 데이터 라벨링과 검증용 세션 확보 방법.

이미지 크기, 모델 설정, debounce/timeout, 후보 수용 기준은
위 계약을 바꾸지 않는 실험 설정으로 두고 측정으로 결정한다.
