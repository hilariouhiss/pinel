import { useEffect, useRef, useState } from "react";
import type { ModeState } from "../types";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import deleteIcon from "lucide-static/icons/trash-2.svg";

/**
 * 模式管理弹层（屏幕居中模态，同 extension-popover 模式）：
 * - 模式列表：Default（内置伪模式 = 全部本地 skills）+ 自定义模式按字母序，
 *   单选切换（switchMode，宿主写盘后提示 reload），× 删除（Default 不可删）
 * - 选中模式编辑区：本地 skill 勾选清单（scope 徽标 + description 省略，
 *   按名称字母序），勾选即 updateModeSkills
 * - 底部新建行：输入 + Add
 * - 数据源：宿主 getModeState（打开时拉取；操作后宿主重发 modeState 刷新）
 * - 交互：Esc / 点击外部 / 标题栏关闭按钮关闭（Esc 在 window capture 阶段
 *   stopPropagation，让位于 Composer 的中断/清空分支）
 */
interface Props {
  /** 触发按钮元素引用（非 null 即打开，仅作开关信号）。 */
  anchor: HTMLElement | null;
  /** 模式状态（宿主 modeState 消息；null = 未拉取）。 */
  state: ModeState | null;
  onSwitch: (name: string | null) => void;
  onCreate: (name: string) => void;
  onDelete: (name: string) => void;
  onUpdateSkills: (name: string, skills: string[], extensions: string[]) => void;
  onClose: () => void;
}

export function ModePopover({ anchor, state, onSwitch, onCreate, onDelete, onUpdateSkills, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  /** 编辑中的模式名（null = Default/无选中；打开时默认选中当前激活模式）。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  // Esc 关闭：capture 阶段拦截 + stopPropagation，防止 Composer 的 Esc 分支同时触发
  useEffect(() => {
    if (!anchor) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [anchor, onClose]);

  // 打开时焦点移入弹层；关闭时焦点还原到触发按钮（对齐 ExtensionPopover）
  useEffect(() => {
    if (!anchor) {
      return;
    }
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (triggerRef.current && triggerRef.current.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [anchor]);

  // 打开/状态刷新：编辑目标跟随激活模式（激活项被删/切换时编辑区自动跟随）
  useEffect(() => {
    setEditing(state?.active ?? null);
  }, [anchor, state?.active]);

  if (!anchor) {
    return null;
  }

  const modes = state ? [...state.modes].sort((a, b) => a.name.localeCompare(b.name)) : [];
  const editingMode = editing ? modes.find((m) => m.name === editing) : undefined;
  // 编辑区清单：字母序；模式配置里已卸载的 id 不展示（保存时宿主顺带剔除）
  const skillList = state ? [...state.skills].sort((a, b) => a.name.localeCompare(b.name)) : [];
  const extList = state ? [...state.extensions].sort((a, b) => a.name.localeCompare(b.name)) : [];
  const editingSkills = new Set(editingMode?.skills ?? []);
  const editingExts = new Set(editingMode?.extensions ?? []);

  const toggle = (list: "skills" | "extensions", id: string) => {
    if (!editingMode) {
      return;
    }
    const current = list === "skills" ? editingMode.skills : editingMode.extensions;
    const selected = list === "skills" ? editingSkills : editingExts;
    const next = selected.has(id) ? current.filter((s) => s !== id) : [...current, id];
    onUpdateSkills(
      editingMode.name,
      list === "skills" ? next : editingMode.skills,
      list === "extensions" ? next : editingMode.extensions,
    );
  };

  const submitCreate = () => {
    const name = newName.trim();
    if (!name) {
      return;
    }
    onCreate(name);
    setNewName("");
    setEditing(name);
  };

  return (
    <>
      <div className="extension-popover-overlay" onClick={onClose} />
      <div className="extension-popover" role="dialog" aria-label="Modes" tabIndex={-1} ref={panelRef}>
        <div className="popover-titlebar">
          <span className="popover-titlebar-title">Modes</span>
          <button className="popover-close" aria-label="Close modes" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="popover-body">
          <div className="extension-popover-section">
            <div className="extension-popover-title">Active mode</div>
            <label className="mode-row">
              <input
                type="radio"
                name="pinel-mode"
                checked={!state?.active}
                onChange={() => onSwitch(null)}
              />
              <span className="mode-row-name">Default</span>
              <span className="mode-row-desc">All local skills</span>
            </label>
            {modes.map((m) => (
              <div key={m.name} className={`mode-row${editing === m.name ? " editing" : ""}`}>
                <input
                  type="radio"
                  name="pinel-mode"
                  title={`Switch to ${m.name}`}
                  aria-label={`Switch to ${m.name}`}
                  checked={state?.active === m.name}
                  onChange={() => onSwitch(m.name)}
                />
                <span
                  className="mode-row-name"
                  title={`Edit skills of ${m.name}`}
                  onClick={() => setEditing(m.name)}
                >
                  {m.name}
                </span>
                <span className="mode-row-desc">
                  {m.skills.length} skill{m.skills.length === 1 ? "" : "s"}
                </span>
                <button
                  className="extension-item-delete"
                  title={`Delete ${m.name}`}
                  aria-label={`Delete ${m.name}`}
                  onClick={() => {
                    if (editing === m.name) {
                      setEditing(null);
                    }
                    onDelete(m.name);
                  }}
                  dangerouslySetInnerHTML={{ __html: deleteIcon }}
                />
              </div>
            ))}
          </div>
          {editingMode && (
            <>
              <div className="extension-popover-section">
                <div className="extension-popover-title">Skills in “{editingMode.name}”</div>
                {skillList.length === 0 ? (
                  <div className="extension-popover-empty">No skills found</div>
                ) : (
                  skillList.map((s) => (
                    <label key={s.id} className="mode-skill-row">
                      <input
                        type="checkbox"
                        checked={editingSkills.has(s.id)}
                        onChange={() => toggle("skills", s.id)}
                      />
                      <span className="mode-skill-name" title={s.package ? `${s.package} · ${s.id}` : s.id}>
                        {s.name}
                      </span>
                      <span
                        className="extension-item-badge"
                        title={s.package}
                      >
                        {s.scope === "package" ? "pkg" : s.scope}
                      </span>
                      {s.description && <span className="mode-skill-desc">{s.description}</span>}
                    </label>
                  ))
                )}
              </div>
              <div className="extension-popover-section">
                <div className="extension-popover-title">Extensions in “{editingMode.name}”</div>
                {extList.length === 0 ? (
                  <div className="extension-popover-empty">No extensions found</div>
                ) : (
                  extList.map((e) => (
                    <label key={e.id} className="mode-skill-row">
                      <input
                        type="checkbox"
                        checked={editingExts.has(e.id)}
                        onChange={() => toggle("extensions", e.id)}
                      />
                      <span className="mode-skill-name" title={e.package ? `${e.package} · ${e.id}` : e.id}>
                        {e.name}
                      </span>
                      <span className="extension-item-badge" title={e.package}>
                        {e.scope === "package" ? "pkg" : e.scope}
                      </span>
                    </label>
                  ))
                )}
              </div>
              <div className="extension-popover-section">
                <div className="mode-hint">
                  Changing resources in the active mode takes effect after reload.
                </div>
              </div>
            </>
          )}
          <div className="extension-popover-section">
            <div className="extension-popover-title">New mode</div>
            <div className="mode-create-row">
              <input
                className="mode-create-input"
                placeholder="Mode name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCreate();
                  }
                }}
              />
              <button className="catalog-group-install" disabled={!newName.trim()} onClick={submitCreate}>
                Add
              </button>
            </div>
            {modes.length > 0 && (
              <div className="mode-hint">Click a mode name above to edit its skills.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
