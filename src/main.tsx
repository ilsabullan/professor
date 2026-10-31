import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { laserLog, onLaserEnd, onStrokeEnd } from "./lib/events";
import "./styles.css";

// 개발 중 콘솔에서 이벤트를 확인할 수 있게 열어 둔다 (예: ink.onStrokeEnd(console.log))
if (import.meta.env.DEV) Object.assign(window, { ink: { onStrokeEnd, onLaserEnd, laserLog } });

// 아이패드 사파리는 터치 리스너가 있어야 :active(누르는 동안 회색 표시)가 바로 적용된다
document.addEventListener("touchstart", () => {}, { passive: true });
// 사파리가 화면 전체를 확대하지 않게 막는다 (필기 화면은 직접 확대·축소를 처리한다)
document.addEventListener("gesturestart", (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
