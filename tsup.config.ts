import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts", "src/lean.ts", "src/contract.ts"],
  format: ["esm"],
  target: "es2022",
  dts: false,
  sourcemap: true,
  clean: true,
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
  ],
  noExternal: ["typebox", "acp-kernel"],
});
