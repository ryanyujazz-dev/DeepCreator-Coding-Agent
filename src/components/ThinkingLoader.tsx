import Lottie from "lottie-react";
import thinkingLoaderData from "../assets/thinking-loader.json";

// 思考动效图标(基于 Lottie loadingV4:8 道光芒依次淡入淡出)。
// 用于思考槽位左侧,替代之前的静态文字。颜色继承 currentColor。
export function ThinkingLoader({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="thinking-loader"
      style={{ width: size, height: size, display: "inline-flex", flex: "0 0 auto" }}
    >
      <Lottie
        animationData={thinkingLoaderData}
        loop
        autoplay
        style={{ width: "100%", height: "100%" }}
      />
    </span>
  );
}
