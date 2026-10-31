import type { ReactNode } from "react";

export type MenuItem = {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/** 버튼 아래에 뜨는 메뉴. 부모 요소가 position: relative 여야 한다. 바깥을 누르면 닫힌다 */
export function Menu({
  items,
  align = "center",
  onClose,
}: {
  items: MenuItem[];
  align?: "center" | "right";
  onClose: () => void;
}) {
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className={`menu menu-${align}`} role="menu">
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            className={item.danger ? "danger" : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.icon}
          </button>
        ))}
      </div>
    </>
  );
}
