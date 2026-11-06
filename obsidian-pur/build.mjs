import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
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
      builder.onResolve({ filter: /^(?:node:|fs$|path$)/ }, args => ({ path: args.path, namespace: "no-node" }));
      builder.onLoad({ filter: /.*/, namespace: "no-node" }, () => ({
        contents: 'throw new Error("Node.js APIs are disabled in the PUR viewer");',
        loader: "js",
      }));
      builder.onLoad({ filter: /libheif-js[\\/]libheif[\\/]libheif\.js$/ }, async args => ({
        // Emscripten checks bare process too; desktop Obsidian must not select Node.
        contents: `var process = undefined;\n${await readFile(args.path, "utf8")}`,
        loader: "js",
      }));
      builder.onLoad({ filter: /heic-worker-source\.ts$/ }, async () => {
        const worker = await build({
          ...browserOptions, entryPoints: ["src/heic-worker.ts"], write: false,
          format: "iife", minify: true, legalComments: "eof",
        });
        return { contents: `export default ${JSON.stringify(worker.outputFiles[0].text)};`, loader: "js" };
      });
      builder.onLoad({ filter: /libheif-wasm[\\/]libheif-bundle\.js$/ }, async args => ({
        contents: `var process = undefined;\n${await readFile(args.path, "utf8")}`, loader: "js",
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
  const heifLicense = await readFile(join(root, "node_modules/libheif-js/libheif/LICENSE"), "utf8");
  const sourceNotes = await readFile(join(root, "third-party/heic-source/BUILD-AND-LICENSE.txt"), "utf8");
  const emscriptenLicense = await readFile(join(root, "third-party/heic-source/EMSCRIPTEN-LICENSE.txt"), "utf8");
  await writeFile(join(dist, "THIRD-PARTY-NOTICES.txt"),
    `LazyRef (MIT)\n${ownLicense}\n\nsql.js (MIT), bundled SQLite (public domain)\n${license}\n\nspark-md5\n${md5License}` +
    `\n\nlibheif-js 1.23.5 / libheif / libde265 (LGPL-3.0)\n${heifLicense}` +
    `\n\nEmscripten runtime (MIT / University of Illinois-NCSA)\n${emscriptenLicense}\n\n${sourceNotes}`);
  const sources = join(dist, "HEIC-SOURCES");
  await cp(join(root, "third-party/heic-source"), sources, { recursive: true });
  const application = join(sources, "application");
  await mkdir(application, { recursive: true });
  await cp(join(root, "src"), join(application, "src"), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "build.mjs", "tsconfig.json",
    "manifest.json", "styles.css", "README.md"])
    await copyFile(join(root, name), join(application, name));
  await copyFile(join(root, "../LICENSE"), join(sources, "LICENSE"));
}
