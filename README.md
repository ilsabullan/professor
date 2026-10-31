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
접속 코드는 서버를 켤 때마다 새로 만들어지고, 코드 없이 연 기기는 AI 프록시를 쓸 수 없다 (키 보호).
이 Mac에서 HTTPS 없이 보려면 `DEV_HTTP=1 npm run dev`.

## 화면

- 문서 목록에서 PDF를 올리고 차시를 연다.
- 필기 화면 왼쪽은 PDF 편집기, 그 페이지 위에 애니메이션이 겹쳐 그려진다.
- 오른쪽은 애니메이션 테스트 패널(대본, 말하기, 실험 설정, 측정). 상단의 플라스크 버튼으로 켜고 끈다.

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
- AI 반응: Haiku 5.5, 생각 끔, 스트리밍. 줄이 끝나기 전에도 완성된 동작부터 재생한다. 시스템 프롬프트는 캐시하고 페이지를 열 때 미리 데운다.
- 측정 패널에서 설정별 중앙값·90%·1초 이내 비율을 보고 CSV로 저장할 수 있다.
