import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export const browserOptions = {
  absWorkingDir: root,
  bundle: true,
  platform: "browser",
  target: "es2020",
  // Obsidian desktop exposes process too. Always select sql.js's browser backend.
  define: { "globalThis.process": "undefined" },
  plugins: [{
    name: "no-node-runtime",
    setup(builder) {
      builder.onResolve({ filter: /^node:/ }, args => ({ path: args.path, namespace: "no-node" }));
      builder.onLoad({ filter: /.*/, namespace: "no-node" }, () => ({
        contents: 'throw new Error("Node.js APIs are disabled in the PUR viewer");',
        loader: "js",
      }));
    },
  }],
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  await build({
    ...browserOptions,
    entryPoints: ["src/main.ts"],
    outfile: join(dist, "main.js"),
    format: "cjs",
    external: ["obsidian"],
    minify: true,
    legalComments: "eof",
  });
  for (const name of ["manifest.json", "styles.css"]) await copyFile(join(root, name), join(dist, name));
  const license = await readFile(join(root, "node_modules/sql.js/LICENSE"), "utf8");
  const md5License = await readFile(join(root, "node_modules/spark-md5/LICENSE"), "utf8");
  const ownLicense = await readFile(join(root, "../LICENSE"), "utf8");
  await writeFile(join(dist, "THIRD-PARTY-NOTICES.txt"),
    `LazyRef (MIT)\n${ownLicense}\n\nsql.js (MIT), bundled SQLite (public domain)\n${license}\n\nspark-md5\n${md5License}`);
}
