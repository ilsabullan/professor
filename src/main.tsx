import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Pipeline } from "./animation/pipeline";
import { InkBus } from "./shared/bus";
import { LESSONS } from "./dev/lessons";
import { logEntry, startTestLog } from "./dev/testlog";
import { AudioLog } from "./dev/audiolog";
import { laserLog, onLaserEnd, onStrokeEnd } from "./lib/events";
import "./styles.css";

// 한 번만 만든다. 애니메이션 쪽이 먼저 구독해야 편집기의 첫 이벤트(page)를 받는다
const bus = new InkBus();
const pipeline = new Pipeline(bus);
pipeline.engine.paper = true; // PDF(흰 종이) 위에 그린다

// 개발 중에는 테스트 기록을 서버(logs/)에 쌓고, 콘솔에서 상태를 볼 수 있게 열어 둔다
if (import.meta.env.DEV) {
  pipeline.log = logEntry;
  startTestLog();
  // 음성 인식기 비교용 원본 녹음: 마이크를 켠 동안만
  const audio = new AudioLog(logEntry);
  pipeline.subscribe(() => audio.sync(pipeline.mic === "on"));
  Object.assign(window, { __pipeline: pipeline, __bus: bus, __dev: { LESSONS }, ink: { onStrokeEnd, onLaserEnd, laserLog } });
}

// 아이패드 사파리는 터치 리스너가 있어야 :active(누르는 동안 회색 표시)가 바로 적용된다
document.addEventListener("touchstart", () => {}, { passive: true });
// 사파리가 화면 전체를 확대하지 않게 막는다 (필기 화면은 직접 확대·축소를 처리한다)
document.addEventListener("gesturestart", (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App pipeline={pipeline} bus={bus} />
  </StrictMode>,
);
