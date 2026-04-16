import { build } from "esbuild";
import { execSync } from "child_process";
import { mkdirSync, rmSync } from "fs";

rmSync("bin", { recursive: true, force: true });
mkdirSync("bin", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "bin/index.js",
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: [],
});

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "bin/index.cjs",
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: [],
});

execSync("npx tsc --emitDeclarationOnly", { stdio: "inherit" });

console.log("Build complete: bin/index.js + bin/index.cjs + bin/index.d.ts");
