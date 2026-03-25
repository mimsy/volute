export type TooltipPosition = "top" | "bottom" | "left" | "right";
export type TooltipOptions = string | { text: string; position?: TooltipPosition };

function resolveOptions(opts: TooltipOptions): { text: string; position: TooltipPosition } {
  if (typeof opts === "string") return { text: opts, position: "top" };
  return { text: opts.text, position: opts.position ?? "top" };
}

export function tooltip(node: HTMLElement, opts: TooltipOptions) {
  let el: HTMLDivElement | null = null;
  let text: string;
  let pos: TooltipPosition;
  ({ text, position: pos } = resolveOptions(opts));
  if (text && !node.getAttribute("aria-label")) node.setAttribute("aria-label", text);

  function positionEl(tip: HTMLDivElement) {
    const rect = node.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const gap = 6;
    let top: number;
    let left: number;

    switch (pos) {
      case "bottom":
        top = rect.bottom + gap;
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        break;
      case "left":
        top = rect.top + rect.height / 2 - tipRect.height / 2;
        left = rect.left - tipRect.width - gap;
        break;
      case "right":
        top = rect.top + rect.height / 2 - tipRect.height / 2;
        left = rect.right + gap;
        break;
      default: // top
        top = rect.top - tipRect.height - gap;
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        break;
    }

    // Clamp to viewport
    left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - tipRect.height - 4));

    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }

  function show() {
    if (!text) return;
    el = document.createElement("div");
    el.className = "volute-tooltip";
    el.textContent = text;
    document.body.appendChild(el);
    positionEl(el);
  }

  function hide() {
    el?.remove();
    el = null;
  }

  node.addEventListener("mouseenter", show);
  node.addEventListener("mouseleave", hide);

  return {
    update(newOpts: TooltipOptions) {
      ({ text, position: pos } = resolveOptions(newOpts));
      if (text && !node.getAttribute("aria-label")) node.setAttribute("aria-label", text);
      if (el) {
        el.textContent = text;
        positionEl(el);
      }
    },
    destroy() {
      hide();
      node.removeEventListener("mouseenter", show);
      node.removeEventListener("mouseleave", hide);
    },
  };
}
