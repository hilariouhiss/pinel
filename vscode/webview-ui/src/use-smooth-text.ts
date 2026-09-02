/**
 * 流式文本平滑揭示 hook：live 时以 rAF 逐帧推进（revealAdvance 节奏），
 * 完成态/重置（目标收缩）直接对齐全量——快照重放与 message_end 无动画。
 */
import { useEffect, useRef, useState } from "react";
import { revealAdvance } from "./smooth-text";

export function useSmoothText(target: string, live: boolean): string {
  const [shown, setShown] = useState(target);
  const shownLenRef = useRef(target.length);
  useEffect(() => {
    if (!live || target.length <= shownLenRef.current) {
      // 完成态或目标收缩/无新内容：直接对齐
      shownLenRef.current = target.length;
      setShown(target);
      return;
    }
    let raf = 0;
    const tick = () => {
      const { next, done } = revealAdvance(target.length, shownLenRef.current);
      shownLenRef.current = next;
      setShown(target.slice(0, next));
      if (!done) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, live]);
  return live ? shown : target;
}
