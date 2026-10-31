# professor

교수자가 강의자료(PDF) 위에 필기하는 웹 앱. 작업 범위는 [docs/scope.md](docs/scope.md) 참고.

디자인: [Figma - 교수자 필기 화면](https://www.figma.com/design/varfI1eZkbR9f7FQ8DUCLy) (문서 목록, 필기 화면, 모아보기, 모아보기 팝업, 컴포넌트)

## 실행

```bash
npm install
npm run dev
```

브라우저에서 http://localhost:5173 을 연다. 같은 와이파이의 아이패드에서는 터미널에 나오는 `Network` 주소로 접속한다.

## 구조

| 경로 | 내용 |
|---|---|
| `src/screens/LectureList.tsx` | 차시 목록, PDF 업로드 |
| `src/screens/Editor.tsx` | 필기 화면 (도구 모음, 페이지 이동, 확대, 실행 취소, 저장) |
| `src/components/PageCanvas.tsx` | 한 페이지의 PDF·필기·레이저 그리기와 펜 입력 |
| `src/components/Overview.tsx` | 모아보기 |
| `src/lib/events.ts` | 애니메이션 쪽에 넘기는 이벤트 (`onStrokeEnd`, `onLaserEnd`) |
| `src/lib/db.ts` | 브라우저 저장 (IndexedDB) |
