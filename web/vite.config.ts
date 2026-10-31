import { defineConfig } from "vite";

// 前端是纯静态产物：daemon 直接服务 web/dist；不引 @vitejs/plugin-react（esbuild 已覆盖 TSX 编译，无 HMR 需求）。
export default defineConfig({
  build: {
    target: "es2022",
  },
  esbuild: {
    jsx: "automatic",
  },
});
