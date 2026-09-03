import { useEffect, useRef, useState } from "react";
import type { ModeExtension, ModePrompt, ModeSkill, ModeState } from "../types";
import { groupCheckState, groupPackageResources, type PackageGroup, type PackageGroupItem } from "../mode-groups";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import deleteIcon from "lucide-static/icons/trash-2.svg";
import chevronRightIcon from "lucide-static/icons/chevron-right.svg";
import chevronDownIcon from "lucide-static/icons/chevron-down.svg";
import chevronsDownIcon from "lucide-static/icons/chevrons-down.svg";
import chevronsUpIcon from "lucide-static/icons/chevrons-up.svg";
import xIcon from "lucide-static/icons/x.svg";

/**
 * 模式管理弹层（屏幕居中模态，同 extension-popover 模式）：
 * - 模式列表：Default（内置伪模式 = 全部资源生效）+ 自定义模式按字母序，
 *   单选切换（switchMode，宿主写盘后提示 reload），× 删除（Default 不可删）
 * - 选中模式编辑区：
 *   - Skills 区：仅本地 skill（global/project 徽标），逐个勾选
 *   - Prompts 区：仅本地 prompt，逐个勾选
 *   - Extensions 区：包组（主勾选框 = 整包开关，展开后缩进展示该包的 skills
 *     与 extensions 与 prompts，无单项勾选）+ 本地扩展逐个勾选；标题行带全部展开/折叠按钮
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
  onUpdateSkills: (name: string, skills: string[], extensions: string[], prompts: string[]) => void;
  onClose: () => void;
}

export function ModePopover({ anchor, state, onSwitch, onCreate, onDelete, onUpdateSkills, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  /** 编辑中的模式名（null = Default/无选中；打开时默认选中当前激活模式）。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  /** 折叠的包组键（弹层重开即复位）。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

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
  const promptList = state ? [...state.prompts].sort((a, b) => a.name.localeCompare(b.name)) : [];
  // Skills/Prompts 区 = 仅本地；Extensions 区 = 包组（含包 skills/extensions/prompts）+ 本地扩展
  const localSkills = skillList.filter((s) => s.scope !== "package");
  const localExts = extList.filter((e) => e.scope !== "package");
  const localPrompts = promptList.filter((p) => p.scope !== "package");
  const pkgGroups = groupPackageResources(skillList, extList, promptList);
  const editingSkills = new Set(editingMode?.skills ?? []);
  const editingExts = new Set(editingMode?.extensions ?? []);
  const editingPrompts = new Set(editingMode?.prompts ?? []);

  const toggle = (list: "skills" | "extensions" | "prompts", id: string) => {
    if (!editingMode) {
      return;
    }
    const current =
      list === "skills" ? editingMode.skills
        : list === "extensions" ? editingMode.extensions
        : editingMode.prompts;
    const selected =
      list === "skills" ? editingSkills
        : list === "extensions" ? editingExts
        : editingPrompts;
    const next = selected.has(id) ? current.filter((s) => s !== id) : [...current, id];
    onUpdateSkills(
      editingMode.name,
      list === "skills" ? next : editingMode.skills,
      list === "extensions" ? next : editingMode.extensions,
      list === "prompts" ? next : editingMode.prompts,
    );
  };

  /** 包组主勾选（整包开关）：全选 → 整组取消；否则 skills + extensions + prompts 一并勾上。 */
  const toggleGroup = (group: PackageGroup) => {
    if (!editingMode) {
      return;
    }
    const skillIds = new Set(group.items.filter((i) => i.kind === "skill").map((i) => i.id));
    const extIds = new Set(group.items.filter((i) => i.kind === "extension").map((i) => i.id));
    const promptIds = new Set(group.items.filter((i) => i.kind === "prompt").map((i) => i.id));
    const isSelected = (i: PackageGroupItem) =>
      i.kind === "skill" ? editingSkills.has(i.id)
        : i.kind === "extension" ? editingExts.has(i.id)
        : editingPrompts.has(i.id);
    const allSelected = group.items.every(isSelected);
    const nextSkills = allSelected
      ? editingMode.skills.filter((s) => !skillIds.has(s))
      : [...editingMode.skills, ...group.items.filter((i) => i.kind === "skill" && !editingSkills.has(i.id)).map((i) => i.id)];
    const nextExts = allSelected
      ? editingMode.extensions.filter((e) => !extIds.has(e))
      : [...editingMode.extensions, ...group.items.filter((i) => i.kind === "extension" && !editingExts.has(i.id)).map((i) => i.id)];
    const nextPrompts = allSelected
      ? editingMode.prompts.filter((p) => !promptIds.has(p))
      : [...editingMode.prompts, ...group.items.filter((i) => i.kind === "prompt" && !editingPrompts.has(i.id)).map((i) => i.id)];
    onUpdateSkills(editingMode.name, nextSkills, nextExts, nextPrompts);
  };

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  /** 本地资源勾选行（skill 带 description 列；徽标 = scope）。 */
  const renderLocalRow = (list: "skills" | "extensions" | "prompts", item: ModeSkill | ModeExtension | ModePrompt, selected: Set<string>, showDesc: boolean) => (
    <label key={item.id} className="mode-skill-row">
      <input
        type="checkbox"
        checked={selected.has(item.id)}
        onChange={() => toggle(list, item.id)}
      />
      <span className="mode-skill-name" title={item.id}>
        {item.name}
      </span>
      <span className="extension-item-badge" title={item.scope}>
        {item.scope}
      </span>
      {showDesc && (item as ModeSkill).description && (
        <span className="mode-skill-desc">{(item as ModeSkill).description}</span>
      )}
    </label>
  );

  const setAllCollapsed = (collapseAll: boolean) => {
    setCollapsed(collapseAll ? new Set(pkgGroups.map((g) => g.key)) : new Set());
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

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <>
      <div className="extension-popover-overlay" onClick={onClose} />
      <div className="extension-popover" role="dialog" aria-label="Modes" tabIndex={-1} ref={panelRef}>
        <div className="popover-titlebar">
          <span className="popover-titlebar-title">Modes</span>
          <button className="popover-close" aria-label="Close modes" onClick={onClose}>
            <span dangerouslySetInnerHTML={{ __html: xIcon }} />
          </button>
        </div>
        <div className="popover-body">
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
              <div className="mode-hint">Click a mode name below to edit its resources.</div>
            )}
          </div>
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
              <span className="mode-row-desc">All resources active</span>
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
                  title={`Edit resources of ${m.name}`}
                  onClick={() => setEditing(m.name)}
                >
                  {m.name}
                </span>
                <span className="mode-row-desc">
                  {plural(m.skills.length, "skill")} · {plural(m.extensions.length, "extension")} · {plural(m.prompts.length, "prompt")}
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
                {localSkills.length === 0 ? (
                  <div className="extension-popover-empty">No local skills found</div>
                ) : (
                  localSkills.map((s) => renderLocalRow("skills", s, editingSkills, true))
                )}
              </div>
              <div className="extension-popover-section">
                <div className="extension-popover-title">Prompts in “{editingMode.name}”</div>
                {localPrompts.length === 0 ? (
                  <div className="extension-popover-empty">No local prompts found</div>
                ) : (
                  localPrompts.map((p) => renderLocalRow("prompts", p, editingPrompts, true))
                )}
              </div>
              <div className="extension-popover-section">
                <div className="extension-popover-title mode-ext-title">
                  Extensions in “{editingMode.name}”
                  <button
                    className="mode-group-all-btn"
                    title="Expand all"
                    aria-label="Expand all packages"
                    onClick={() => setAllCollapsed(false)}
                  >
                    <span dangerouslySetInnerHTML={{ __html: chevronsDownIcon }} />
                  </button>
                  <button
                    className="mode-group-all-btn"
                    title="Collapse all"
                    aria-label="Collapse all packages"
                    onClick={() => setAllCollapsed(true)}
                  >
                    <span dangerouslySetInnerHTML={{ __html: chevronsUpIcon }} />
                  </button>
                </div>
                {pkgGroups.length === 0 && localExts.length === 0 ? (
                  <div className="extension-popover-empty">No extensions found</div>
                ) : (
                  <>
                    {pkgGroups.map((group) => {
                      const groupState = groupCheckState(
                        group.items,
                        new Set([...editingSkills, ...editingExts, ...editingPrompts]),
                      );
                      const folded = collapsed.has(group.key);
                      return (
                        <div key={group.key} className="mode-group">
                          <div className="mode-group-header">
                            <button
                              className="mode-group-chevron"
                              aria-label={`${folded ? "Expand" : "Collapse"} ${group.label}`}
                              onClick={() => toggleCollapse(group.key)}
                            >
                              <span
                                dangerouslySetInnerHTML={{
                                  __html: folded ? chevronRightIcon : chevronDownIcon,
                                }}
                              />
                            </button>
                            <input
                              type="checkbox"
                              className="mode-group-master"
                              title={`${groupState === "all" ? "Disable" : "Enable"} package ${group.label}`}
                              aria-label={`Toggle package ${group.label}`}
                              checked={groupState === "all"}
                              ref={(el) => {
                                if (el) {
                                  el.indeterminate = groupState === "some";
                                }
                              }}
                              onChange={() => toggleGroup(group)}
                            />
                            <span className="mode-group-name" title={group.key}>
                              {group.label}
                            </span>
                            <span className="mode-group-count">{group.items.length}</span>
                          </div>
                          {!folded &&
                            group.items.map((item) => (
                              <div key={`${item.kind}:${item.id}`} className="mode-skill-row mode-group-item">
                                <span className="extension-item-badge mode-group-kind" title={item.kind}>
                                  {item.kind === "skill" ? "skill" : item.kind === "extension" ? "ext" : "prompt"}
                                </span>
                                <span className="mode-skill-name" title={`${group.label} · ${item.id}`}>
                                  {item.name}
                                </span>
                              </div>
                            ))}
                        </div>
                      );
                    })}
                    {localExts.length > 0 && (
                      <div className="mode-local-label">Local</div>
                    )}
                    {localExts.map((e) => renderLocalRow("extensions", e, editingExts, false))}
                  </>
                )}
              </div>
              <div className="extension-popover-section">
                <div className="mode-hint">
                  Changing resources in the active mode takes effect after reload.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
