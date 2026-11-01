import { useEffect, useState } from "react";
import { LectureList } from "./screens/LectureList";
import { Editor } from "./screens/Editor";
import { AnimationOverlay } from "./animation/AnimationOverlay";
import type { Pipeline } from "./animation/pipeline";
import type { InkBus } from "./shared/bus";
import { TestPanel } from "./dev/TestPanel";

type Route = { name: "list" } | { name: "editor"; lectureId: string; page: number };

// #/l/<차시id>/<쪽 번호>
function parseHash(): Route {
  const m = location.hash.match(/^#\/l\/([^/]+)(?:\/(\d+))?/);
  return m ? { name: "editor", lectureId: m[1], page: m[2] ? Number(m[2]) - 1 : 0 } : { name: "list" };
}

const PANEL_KEY = "testPanelOpen";

// 편집기는 onBack이 바뀌면 차시를 다시 불러오므로, 다시 그려도 같은 함수가 되도록 밖에 둔다
const goToList = () => (location.hash = "#/");
const openLecture = (id: string) => (location.hash = `#/l/${id}/1`);

function loadPanelOpen() {
  try {
    return localStorage.getItem(PANEL_KEY) !== "0";
  } catch {
    return true;
  }
}

export function App({ pipeline, bus }: { pipeline: Pipeline; bus: InkBus }) {
  const [route, setRoute] = useState(parseHash);
  const [panelOpen, setPanelOpen] = useState(loadPanelOpen);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 데모: 강의를 열면 마이크를 바로 켠다 (끄는 것은 실험실의 마이크 버튼)
  const inEditor = route.name === "editor";
  useEffect(() => {
    if (inEditor && pipeline.mic === "off") pipeline.speech.start();
  }, [inEditor, pipeline]);

  const togglePanel = () => {
    setPanelOpen((open) => {
      try {
        localStorage.setItem(PANEL_KEY, open ? "0" : "1");
      } catch {
        // 저장이 막혀 있어도 이번 화면에서는 동작한다
      }
      return !open;
    });
  };

  if (route.name === "editor") {
    // 왼쪽: 필기 화면(페이지 위에 애니메이션), 오른쪽: 테스트 패널
    return (
      <div className="workspace">
        <Editor
          key={route.lectureId}
          lectureId={route.lectureId}
          initialPage={route.page}
          onBack={goToList}
          bus={bus}
          overlay={<AnimationOverlay pipeline={pipeline} showCaption={panelOpen} />}
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
        />
        {panelOpen && <TestPanel pipeline={pipeline} />}
      </div>
    );
  }
  return <LectureList onOpen={openLecture} />;
}
