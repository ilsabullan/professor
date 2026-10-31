import { useState } from "react";

/**
 * 필기 화면 위쪽 제목을 누르면 아래로 뜨는 이름 바꾸기 창 (굿노트처럼).
 * Enter나 바깥을 누르면 저장하고, Esc를 누르면 그대로 닫는다.
 */
export function TitleEditor({
  initial,
  onSave,
  onClose,
}: {
  initial: string;
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const save = () => {
    const title = value.trim();
    if (title && title !== initial) onSave(title);
    onClose();
  };

  return (
    <>
      <div className="menu-backdrop" onClick={save} />
      <form
        className="title-editor"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input
          value={value}
          autoFocus
          aria-label="차시 이름"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
      </form>
    </>
  );
}
