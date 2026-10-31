/** 형광펜 아이콘을 한 번 더 누르면 아래로 뜨는 설정 창 (굿노트처럼). 바깥을 누르면 닫힌다 */
export function HighlighterOptions({
  straight,
  onStraightChange,
  onClose,
}: {
  straight: boolean;
  onStraightChange: (straight: boolean) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="tool-popover" role="dialog" aria-label="형광펜 설정">
        <div className="tool-popover-title">형광펜</div>
        <label className="option-row">
          <span>직선으로 그리기</span>
          <button
            type="button"
            role="switch"
            aria-checked={straight}
            className={`switch${straight ? " on" : ""}`}
            onClick={() => onStraightChange(!straight)}
          >
            <span className="switch-knob" />
          </button>
        </label>
      </div>
    </>
  );
}
