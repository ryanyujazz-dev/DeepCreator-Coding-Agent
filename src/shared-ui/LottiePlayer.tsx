import Lottie from "lottie-react";

// Keep CommonJS interop at a normal module boundary. Passing the raw dynamic
// import to React.lazy can expose lottie-react's nested module object as the
// component type in packaged builds.
export default Lottie;
