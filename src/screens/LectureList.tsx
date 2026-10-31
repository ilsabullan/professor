import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { Lecture, Page } from "../types";
import { deleteLecture, listLectures, putLecture, putPdf } from "../lib/db";
import { forgetLecturePdf, openPdf, renderPdfPage } from "../lib/pdf";
import { uid } from "../lib/id";

async function createLecture(file: File, order: number): Promise<Lecture> {
  const data = await file.arrayBuffer();
  const doc = await openPdf(data);
  try {
    const pages: Page[] = [];
    for (let i = 0; i < doc.numPages; i++) {
      const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      pages.push({ id: uid(), pdfPageIndex: i, width: vp.width, height: vp.height });
    }
    const thumb = document.createElement("canvas");
    await renderPdfPage(doc, 0, thumb, 480).promise;
    const now = Date.now();
    const lecture: Lecture = {
      id: uid(),
      title: `${order}차시`,
      fileName: file.name,
      createdAt: now,
      updatedAt: now,
      pages,
      thumbnail: thumb.toDataURL("image/jpeg", 0.8),
    };
    await putPdf(lecture.id, data);
    await putLecture(lecture);
    return lecture;
  } finally {
    doc.loadingTask.destroy();
  }
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function LectureList({ onOpen }: { onOpen: (id: string) => void }) {
  const [lectures, setLectures] = useState<Lecture[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => listLectures().then(setLectures);
  useEffect(() => {
    reload();
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      await createLecture(file, (lectures?.length ?? 0) + 1);
      await reload();
    } catch (e) {
      console.error(e);
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      alert(`PDF를 불러오지 못했어요. 파일을 확인해 주세요.\n\n(${detail})`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const rename = async (lecture: Lecture) => {
    setMenuFor(null);
    const title = prompt("차시 이름", lecture.title)?.trim();
    if (!title || title === lecture.title) return;
    await putLecture({ ...lecture, title });
    await reload();
  };

  const remove = async (lecture: Lecture) => {
    setMenuFor(null);
    if (!confirm(`"${lecture.title}"을(를) 삭제할까요? 필기도 함께 지워져요.`)) return;
    forgetLecturePdf(lecture.id);
    await deleteLecture(lecture.id);
    await reload();
  };

  return (
    <div className="library">
      <header className="library-header">
        <div className="brand">
          <img className="brand-logo" src="/logo.png" alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
          <h1>문서</h1>
        </div>
      </header>
      <div className="library-grid">
        <div className="doc">
          <button className="doc-cover doc-cover-new" disabled={uploading} onClick={() => fileRef.current?.click()}>
            <span className="doc-new-tile">
              <Plus size={36} strokeWidth={1.5} />
            </span>
          </button>
          <div className="doc-title-row">
            <span className="doc-title">{uploading ? "불러오는 중..." : "새로 만들기"}</span>
          </div>
          <div className="doc-meta">PDF 가져오기</div>
        </div>

        {lectures?.map((l) => (
          <div key={l.id} className="doc">
            <button className="doc-cover" onClick={() => onOpen(l.id)}>
              {l.thumbnail && <img src={l.thumbnail} alt="" />}
            </button>
            <div className="doc-title-row">
              <button className="doc-title" onClick={() => onOpen(l.id)}>
                {l.title}
              </button>
              <button className="doc-menu-btn" aria-label="더보기" onClick={() => setMenuFor(l.id)}>
                <ChevronDown size={16} strokeWidth={2} />
              </button>
              {menuFor === l.id && (
                <>
                  <div className="menu-backdrop" onClick={() => setMenuFor(null)} />
                  <div className="menu">
                    <button onClick={() => rename(l)}>이름 바꾸기</button>
                    <button className="danger" onClick={() => remove(l)}>
                      삭제
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="doc-meta">{formatDate(l.updatedAt)}</div>
            <div className="doc-meta">{l.pages.length}쪽</div>
          </div>
        ))}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => onFile(e.target.files?.[0])}
      />
    </div>
  );
}
