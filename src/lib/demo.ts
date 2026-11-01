import type { Lecture } from "../types";
import { listLectures } from "./db";

/** 데모를 시작할 때 미리 올라가 있는 강의 자료 (public/demo/) */
const DEMO = [
  { file: "demo-lectures.pdf", title: "데모 강의" },
  { file: "bubble-sort.pdf", title: "버블 정렬 정리" },
];
const SEEDED_KEY = "demoSeeded:v1";

let seeding: Promise<void> | null = null;

/**
 * 이 브라우저에 데모 강의 자료를 한 번만 넣는다. 이미 같은 파일이 있으면 건너뛰고,
 * 한 번 넣은 뒤 지운 자료는 다시 넣지 않는다. 받거나 읽지 못하면 조용히 넘어간다.
 */
export function seedDemoLectures(
  create: (file: File, existing: Lecture[], title: string) => Promise<Lecture>,
): Promise<void> {
  seeding ??= (async () => {
    try {
      if (localStorage.getItem(SEEDED_KEY)) return;
    } catch {
      // 저장소가 막혀 있으면 파일 이름으로만 중복을 막는다
    }
    try {
      const existing = await listLectures();
      for (const d of DEMO) {
        if (existing.some((l) => l.fileName === d.file)) continue;
        const res = await fetch(`${import.meta.env.BASE_URL}demo/${d.file}`);
        if (!res.ok) throw new Error(`${d.file}: ${res.status}`);
        const file = new File([await res.arrayBuffer()], d.file, { type: "application/pdf" });
        existing.push(await create(file, existing, d.title));
      }
      try {
        localStorage.setItem(SEEDED_KEY, "1");
      } catch {
        // 위와 같음
      }
    } catch (e) {
      console.warn("데모 강의 자료를 넣지 못했어요", e);
    }
  })();
  return seeding;
}
