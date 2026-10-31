import { useEffect, useState } from "react";
import { LectureList } from "./screens/LectureList";
import { Editor } from "./screens/Editor";

type Route = { name: "list" } | { name: "editor"; lectureId: string; page: number };

// #/l/<차시id>/<쪽 번호>
function parseHash(): Route {
  const m = location.hash.match(/^#\/l\/([^/]+)(?:\/(\d+))?/);
  return m ? { name: "editor", lectureId: m[1], page: m[2] ? Number(m[2]) - 1 : 0 } : { name: "list" };
}

export function App() {
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (route.name === "editor") {
    return (
      <Editor
        key={route.lectureId}
        lectureId={route.lectureId}
        initialPage={route.page}
        onBack={() => (location.hash = "#/")}
      />
    );
  }
  return <LectureList onOpen={(id) => (location.hash = `#/l/${id}/1`)} />;
}
