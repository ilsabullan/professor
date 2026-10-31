import { useState } from "react";
import type { ReactNode } from "react";

// 브라우저 기본 prompt/confirm 대신 쓰는 화면 안의 창 (아이패드에서도 같은 모양으로 뜬다)

function DialogFrame({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogFrame onCancel={onCancel}>
      <div className="dialog-body">
        <h2>{title}</h2>
        {message && <p>{message}</p>}
      </div>
      <div className="dialog-actions">
        <button onClick={onCancel}>취소</button>
        <button className={`strong${danger ? " danger" : ""}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </DialogFrame>
  );
}

export function PromptDialog({
  title,
  initial,
  confirmLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  return (
    <DialogFrame onCancel={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onSubmit(trimmed);
        }}
      >
        <div className="dialog-body">
          <h2>{title}</h2>
          <input
            className="dialog-input"
            value={value}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="strong" disabled={!trimmed}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
