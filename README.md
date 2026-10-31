# professor

교수자 화면: 강의 자료(PDF) 위에 필기하고 말하면, AI가 "시간에 따라 변하는 설명"을 알아채 필기 위에서 움직이게 한다.
필기 앱 작업 범위는 [docs/scope.md](docs/scope.md) 참고.

디자인: [Figma - 교수자 필기 화면](https://www.figma.com/design/varfI1eZkbR9f7FQ8DUCLy) (문서 목록, 필기 화면, 모아보기, 모아보기 팝업, 컴포넌트)

## 실행

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY 채우기
npm run dev            # https://localhost:5173
```

키는 Vite 개발 서버 프록시(`/api/anthropic`)에서만 쓰이고 브라우저로 내려가지 않는다.

같은 와이파이의 다른 기기(태블릿 등)에서는 서버 터미널에 찍히는 `https://<내부망 IP>:5173/?k=<접속 코드>`로 연다.
마이크·음성 인식 때문에 HTTPS(자체 인증서)라 처음 한 번 브라우저 경고를 넘겨야 한다.
접속 코드는 설정 자동 재시작에도 유지된다. `.env.local`의 `ILSABULLAN_DEV_ACCESS_CODE`로 지정하면 프로세스를 다시 켜도 같은 코드를 쓴다. 접속 코드 없이 연 기기는 AI 프록시를 쓸 수 없다 (키 보호).

기본 코드는 새 서버 프로세스에서 만들어진다.
이 Mac에서 HTTPS 없이 보려면 `DEV_HTTP=1 npm run dev`.

## 화면

- 문서 목록에서 PDF를 올리고 차시를 연다.
- 필기 화면 왼쪽은 PDF 편집기, 그 페이지 위에 애니메이션이 겹쳐 그려진다.
- 오른쪽은 애니메이션 테스트 패널(대본, 말하기, 실험 설정, 측정). 상단의 플라스크 버튼으로 켜고 끈다.

## 배포

라즈베리파이 deployd로 배포한다 (`deploy.json`, `Dockerfile`). deployd는 `ghcr.io/hurdoo/` 이미지만 받으므로 이미지는 포크 `HURDOO/professor`에 연결된 `ghcr.io/hurdoo/ilsabullan-professor`에 올린다. 주소는 https://ilsabullan-professor.app.hurdoo.kr/?k=<접속 코드>.

- 운영 서버는 `server/prod.ts` (`npm start`). 의존성 없이 `dist/`를 내주고 `/healthz`, `/api/status`, `/api/anthropic/*`, `/api/stt/<업체>`를 처리한다.
- 공개 주소라서 `/api/*`는 `?k=<접속 코드>`로 한 번 연 기기만 쓸 수 있다.
- 값은 deployd 대시보드 Secrets에만 넣는다. 필수: `ILSABULLAN_ACCESS_CODE`(공백 없는 6~128자). 선택: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.
- 테스트 기록(`/api/log`)과 원본 녹음은 개발 서버에서만 저장된다.

## 구조

| 경로 | 내용 |
| --- | --- |
| `src/screens/LectureList.tsx` | 차시 목록, PDF 업로드 |
| `src/screens/Editor.tsx` | 필기 화면 (도구 모음, 페이지 이동, 확대, 실행 취소, 저장, 애니메이션 연결) |
| `src/components/PageCanvas.tsx` | 한 페이지의 PDF·필기·레이저 그리기와 펜 입력 |
| `src/components/Overview.tsx` | 모아보기 |
| `src/lib/db.ts` | 브라우저 저장 (IndexedDB) |
| `src/lib/inkBridge.ts` | 편집기 필기 → 애니메이션 계약 좌표 변환 |
| `src/shared/ink.ts` | **필기 데이터 계약** (PDF 편집기 ↔ 애니메이션 레이어) |
| `src/shared/bus.ts` | 두 쪽을 잇는 이벤트 통로 `InkBus` |
| `src/animation/` | 애니메이션 레이어: 필기 해석, 즉시 반응, AI 호출, 재생 |
| `src/dev/` | 테스트 패널, 대본(가상 교안), 테스트 기록 |
| `src/testboard/` | 예전 테스트용 필기 캔버스 (지금은 화면에 쓰지 않음) |

## 편집기와 애니메이션 연결

1. `main.tsx`에서 `InkBus` 하나를 만들고 `new Pipeline(bus)`로 애니메이션 쪽을 먼저 연결한다.
2. 편집기는 페이지를 열 때 `page`(PDF 글자 포함), 획을 쓰거나 지우거나 실행 취소할 때 `stroke`·`erase`, 레이저 포인터는 `point`를 보낸다.
   좌표는 페이지 폭을 1280으로 맞춘 페이지 좌표다 (애니메이션 쪽 크기 기준이 1280 칠판에 맞춰져 있음).
3. `bus.onRequest()`로 `hideStrokes`를 받아 해당 획을 잠시 숨긴다. 애니메이션이 그 획을 대신 움직여 그린다.
4. 페이지 캔버스 바로 위에 같은 크기로 `<AnimationOverlay pipeline={pipeline} />`를 겹친다. 흰 종이용 색(`engine.paper`)으로 그린다.

## 속도 (목표: 행동 → 1초 이내 반응)

- 즉시 반응: 화살표·덧그리기·가리키기·"흘러/막혀" 같은 신호는 AI 없이 바로 움직인다.
- AI 반응: Haiku 5.5, 생각 끔, 스트리밍. 완성된 JSON 단계의 동작을 함께 검증한 뒤 재생한다. 시스템 프롬프트는 캐시하고 페이지를 열 때 미리 데운다.
- 측정 패널에서 설정별 중앙값·90%·1초 이내 비율을 보고 CSV로 저장할 수 있다.

## 실측 기록

`npm run dev`에서 필기·음성 인식 결과·AI 입력/응답·요청 상태를 `logs/<세션>.jsonl`에 저장한다. 이미지는 `logs/<세션>/`에 따로 저장한다. 마이크를 켠 동안의 음성 원본은 `logs/<세션>/audio-<녹음번호>.webm`에 5초 조각을 이어 붙여 저장하고, jsonl의 `audio` 기록에 조각별 시각(`t0`~`t1`, final·interim의 `t`와 같은 시계)을 남긴다. 발화 위치는 `발화 t - audio-start의 t0`초다. 인식기가 주는 대안 후보는 `speech` 기록(`event: alternatives`)에 남는다. 화면의 기록 상태는 서버의 저장 확인을 기준으로 표시하며, ‘보내기’의 저장 건수도 확인된 제출만 센다. 저장 실패 시 큐를 유지하고 1초마다 재시도하며, 같은 기록의 재전송은 서버에서 중복 제거한다.

브라우저 대기열은 메모리에 있으므로 **닫거나 새로고침하기 전 ‘기록 저장 확인됨’을 확인**한다. 페이지 종료 시의 추가 전송은 최선의 시도이며, 큰 이미지나 연결 장애가 있으면 미확인 기록을 보장하지 못한다. 개발 서버 전용 기능이며 배포 빌드에서는 자동 기록하지 않는다.

측정 요약의 중앙값·90%·1초 이내 비율은 첫 동작 시각이 관측된 요청만 대상으로 한다. 중단·오류·무반응·보류·진행 중 건수를 함께 확인한다. 무반응은 의도된 결과일 수도 있으므로 전체 요청 대비 정확도나 성공률로 해석하지 않는다. 확정되지 않은 ‘말 중’ 요청은 집계에서 제외한다. 음성 종료 시각은 인식 이벤트로 추정한 값이고 첫 동작 시각은 실행 시각이므로, 실제 음향 종료부터 화면 표시까지를 직접 측정한 값은 아니다.

요청 로그는 `request-start`와 `request-update`로 진행 상태를 남기고, 기존 `request` 이벤트는 완료 시 입력·응답과 함께 남긴다. 같은 요청의 최신 측정값은 `rec.id`로 연결해 마지막 상태를 사용한다. CSV에는 종료 시각·피드백·실제 모델·전체 설정도 포함된다.

원격 기록 저장에 인증 만료(403)가 표시되면 원래 탭을 유지한 채 같은 브라우저의 새 탭에서 최신 `?k=…` 주소를 연다. 쿠키가 갱신되면 원래 탭에서 대기 기록을 자동 재전송한다.
