const WORKING_GLOW_SELECTOR = ".working-glow, .purpose-sweep";

export const WORKING_SWEEP_BEAT_MS = 1_500;
export const WORKING_SWEEP_SPEED_PX_PER_SECOND = 124;
export const WORKING_SWEEP_WIDTH_PX = 50;

export type WorkingGlowMetrics = {
  activeDurationMs: number;
  activeOffset: number;
  endPosition: number;
  influenceWidth: number;
  periodMs: number;
  startPosition: number;
  textWidth: number;
};

export function workingGlowMetrics(textWidth: number): WorkingGlowMetrics {
  const width = Math.max(0, textWidth);
  const influenceWidth = WORKING_SWEEP_WIDTH_PX;
  const activeDurationMs = width / WORKING_SWEEP_SPEED_PX_PER_SECOND * 1_000;
  const beatCount = Math.max(1, Math.ceil(activeDurationMs / WORKING_SWEEP_BEAT_MS - 1e-9));
  const periodMs = beatCount * WORKING_SWEEP_BEAT_MS;
  return {
    activeDurationMs,
    activeOffset: activeDurationMs / periodMs,
    endPosition: width - influenceWidth / 2,
    influenceWidth,
    periodMs,
    startPosition: -influenceWidth / 2,
    textWidth: width
  };
}

export function installWorkingGlowMotion(root: HTMLElement): () => void {
  const elements = new Set<HTMLElement>();
  const animations = new Map<HTMLElement, { animation: Animation; textWidth: number }>();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const stopAnimation = (element: HTMLElement) => {
    animations.get(element)?.animation.cancel();
    animations.delete(element);
  };

  const renderedTextWidth = (element: HTMLElement): number => {
    const elementWidth = element.getBoundingClientRect().width;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const contentWidth = range.getBoundingClientRect().width;
    range.detach();
    if (contentWidth <= 0) return elementWidth;
    return Math.min(elementWidth, contentWidth);
  };

  const update = (element: HTMLElement) => {
    const width = renderedTextWidth(element);
    if (width <= 0) return;
    const current = animations.get(element);
    if (current && Math.abs(current.textWidth - width) < 0.25 && !reducedMotion.matches) return;
    stopAnimation(element);

    const metrics = workingGlowMetrics(width);
    element.style.setProperty("--working-sweep-duration", `${(metrics.periodMs / 1_000).toFixed(3)}s`);
    if (reducedMotion.matches || typeof element.animate !== "function") return;

    const visibleSize = `${metrics.influenceWidth.toFixed(3)}px 100%, 100% 100%`;
    const hiddenSize = "0px 100%, 100% 100%";
    const startPosition = `${metrics.startPosition.toFixed(3)}px 50%, 0 50%`;
    const endPosition = `${metrics.endPosition.toFixed(3)}px 50%, 0 50%`;
    const keyframes: Keyframe[] = [
      { backgroundPosition: startPosition, backgroundSize: visibleSize, offset: 0 },
      { backgroundPosition: endPosition, backgroundSize: visibleSize, offset: metrics.activeOffset }
    ];
    if (metrics.activeOffset < 1) {
      keyframes.push(
        { backgroundPosition: endPosition, backgroundSize: hiddenSize, offset: metrics.activeOffset },
        { backgroundPosition: endPosition, backgroundSize: hiddenSize, offset: 1 }
      );
    }

    const animation = element.animate(keyframes, {
      duration: metrics.periodMs,
      easing: "linear",
      iterations: Infinity
    });
    const timelineTime = Number(document.timeline.currentTime ?? performance.now());
    animation.currentTime = timelineTime % metrics.periodMs;
    animations.set(element, { animation, textWidth: width });
  };

  const untrack = (element: HTMLElement) => {
    elements.delete(element);
    resizeObserver.unobserve(element);
    stopAnimation(element);
    element.style.removeProperty("--working-sweep-duration");
  };

  const track = (element: HTMLElement) => {
    if (!element.matches(WORKING_GLOW_SELECTOR)) return;
    elements.add(element);
    update(element);
  };

  const trackTree = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    track(node);
    node.querySelectorAll<HTMLElement>(WORKING_GLOW_SELECTOR).forEach(track);
  };

  const untrackTree = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (elements.has(node)) untrack(node);
    node.querySelectorAll<HTMLElement>(WORKING_GLOW_SELECTOR).forEach(untrack);
  };

  const resizeObserver = new ResizeObserver((entries) => {
    entries.forEach((entry) => update(entry.target as HTMLElement));
  });

  const observeTree = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(WORKING_GLOW_SELECTOR)) resizeObserver.observe(node);
    node.querySelectorAll<HTMLElement>(WORKING_GLOW_SELECTOR).forEach((element) => resizeObserver.observe(element));
  };

  trackTree(root);
  observeTree(root);

  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const element = mutation.target as HTMLElement;
        if (element.matches(WORKING_GLOW_SELECTOR)) {
          track(element);
          resizeObserver.observe(element);
        } else {
          untrack(element);
        }
        continue;
      }

      mutation.addedNodes.forEach((node) => {
        trackTree(node);
        observeTree(node);
      });
      mutation.removedNodes.forEach(untrackTree);

      const parent = mutation.target instanceof HTMLElement
        ? mutation.target.closest<HTMLElement>(WORKING_GLOW_SELECTOR)
        : mutation.target.parentElement?.closest<HTMLElement>(WORKING_GLOW_SELECTOR);
      if (parent) update(parent);
    }
  });
  mutationObserver.observe(root, {
    attributes: true,
    attributeFilter: ["class"],
    characterData: true,
    childList: true,
    subtree: true
  });

  const updateAll = () => {
    for (const element of elements) {
      if (element.isConnected) update(element);
      else untrack(element);
    }
  };
  reducedMotion.addEventListener("change", updateAll);
  window.addEventListener("resize", updateAll);

  return () => {
    reducedMotion.removeEventListener("change", updateAll);
    window.removeEventListener("resize", updateAll);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    animations.forEach(({ animation }) => animation.cancel());
    animations.clear();
    elements.clear();
  };
}
