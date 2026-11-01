import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { Lecture, Page } from "../types";
import { deleteLecture, listLectures, putLecture, putPdf } from "../lib/db";
import { forgetLecturePdf, openPdf, renderPdfPage } from "../lib/pdf";
import { uid } from "../lib/id";
import { renameLecture, uniqueTitle } from "../lib/titles";
import { Menu } from "../components/Menu";
import { ConfirmDialog, PromptDialog } from "../components/Dialog";
import { seedDemoLectures } from "../lib/demo";

export async function createLecture(file: File, existing: Lecture[], title?: string): Promise<Lecture> {
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
      title: uniqueTitle(
        title ?? `${existing.length + 1}차시`,
        existing.map((l) => l.title),
      ),
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
  const [dialog, setDialog] = useState<{ kind: "rename" | "delete"; lecture: Lecture } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => listLectures().then(setLectures);
  useEffect(() => {
    // 데모 강의 자료를 처음 한 번 넣어 두고 목록을 보여준다
    seedDemoLectures((file, existing, title) => createLecture(file, existing, title)).finally(reload);
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      await createLecture(file, lectures ?? []);
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

  const rename = async (lecture: Lecture, title: string) => {
    setDialog(null);
    if (title === lecture.title) return;
    await renameLecture(lecture, title);
    await reload();
  };

  const remove = async (lecture: Lecture) => {
    setDialog(null);
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
          <button className="doc-cover" disabled={uploading} onClick={() => fileRef.current?.click()}>
            <span className="doc-tile doc-tile-new">
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
              <span className="doc-tile">{l.thumbnail && <img src={l.thumbnail} alt="" />}</span>
            </button>
            <div className="doc-title-row">
              <button className="doc-title-btn" aria-haspopup="menu" onClick={() => setMenuFor(l.id)}>
                <span className="doc-title">{l.title}</span>
                <ChevronDown size={16} strokeWidth={2} />
              </button>
              {menuFor === l.id && (
                <Menu
                  onClose={() => setMenuFor(null)}
                  items={[
                    { label: "이름 바꾸기", onSelect: () => setDialog({ kind: "rename", lecture: l }) },
                    { label: "삭제", danger: true, onSelect: () => setDialog({ kind: "delete", lecture: l }) },
                  ]}
                />
              )}
            </div>
            <div className="doc-meta">{formatDate(l.updatedAt)}</div>
            <div className="doc-meta">{l.pages.length}쪽</div>
          </div>
        ))}
      </div>
      {dialog?.kind === "rename" && (
        <PromptDialog
          title="차시 이름 바꾸기"
          initial={dialog.lecture.title}
          confirmLabel="저장"
          onSubmit={(title) => rename(dialog.lecture, title)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`"${dialog.lecture.title}"을(를) 삭제할까요?`}
          message="PDF와 필기가 함께 지워지고 되돌릴 수 없어요."
          confirmLabel="삭제"
          danger
          onConfirm={() => remove(dialog.lecture)}
          onCancel={() => setDialog(null)}
        />
      )}
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
