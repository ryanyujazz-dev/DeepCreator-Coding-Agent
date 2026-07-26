import type { LottieRefCurrentProps } from "lottie-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import folderAnimation from "../assets/folder.json";

const Lottie = lazy(() => import("../shared-ui/LottiePlayer"));

export function AnimatedFolderIcon({ expanded, size = 18 }: { expanded: boolean; size?: number }) {
  const animationRef = useRef<LottieRefCurrentProps>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const animation = animationRef.current;
    if (!animation) return;
    const targetFrame = expanded ? 7 : 0;
    if (!initialized.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      animation.goToAndStop(targetFrame, true);
      initialized.current = true;
      return;
    }
    animation.setDirection(expanded ? 1 : -1);
    animation.goToAndPlay(expanded ? 0 : 7, true);
  }, [expanded]);

  return (
    <span aria-hidden="true" className="animated-folder-icon" style={{ height: size, width: size }}>
      <Suspense fallback={null}>
        <Lottie
          animationData={folderAnimation}
          autoplay={false}
          loop={false}
          lottieRef={animationRef}
          style={{ height: "100%", width: "100%" }}
        />
      </Suspense>
    </span>
  );
}
