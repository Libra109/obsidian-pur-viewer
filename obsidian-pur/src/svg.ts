import { check } from "./binary";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const elements = new Set([
  "svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use", "symbol",
  "text", "tspan", "textPath", "title", "desc",
]);

export function svgText(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

export function looksLikeSvg(data: Uint8Array): boolean {
  const text = new TextDecoder().decode(data.subarray(0, 4096));
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/.test(text);
}

function dimensions(width: string | null, height: string | null, viewBox: string | null):
  { width: number; height: number } {
  const length = (value: string | null): number | undefined => {
    if (value === null) return undefined;
    check(/^\s*(?:\d+(?:\.\d*)?|\.\d+)(?:px)?\s*$/.test(value),
      "SVGの幅と高さは正の数値またはpxで指定してください");
    const result = Number(value.trim().replace(/px$/, ""));
    check(Number.isFinite(result) && result > 0, "SVGの寸法が不正です");
    return result;
  };
  let w = length(width), h = length(height);
  let ratio: number | undefined;
  if (viewBox !== null) {
    const values = viewBox.trim().split(/[\s,]+/).map(Number);
    check(values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0,
      "SVGのviewBoxが不正です");
    ratio = values[2] / values[3];
    if (w === undefined && h === undefined) { w = values[2]; h = values[3]; }
  }
  if (w === undefined && h !== undefined && ratio !== undefined) w = h * ratio;
  if (h === undefined && w !== undefined && ratio !== undefined) h = w / ratio;
  check(w !== undefined && h !== undefined, "SVGには幅と高さ、またはviewBoxが必要です");
  w = Math.ceil(w); h = Math.ceil(h);
  check(w > 0 && h > 0 && w * h <= 40_000_000,
    "画像の寸法が不正か、1画像40メガピクセルの上限を超えています");
  return { width: w, height: h };
}

export function svgDimensions(data: Uint8Array): { width: number; height: number } {
  const text = svgText(data);
  check(!/<!DOCTYPE|<!ENTITY/i.test(text), "SVGのDOCTYPEと実体宣言は未対応です");
  check(!/<\?(?!xml\s)/i.test(text), "SVGの処理命令は未対応です");
  const root = text.match(/^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/);
  check(root, "SVGのルート要素が不正です");
  const attribute = (name: string) => {
    const match = root[1].match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`));
    return match?.[2] ?? null;
  };
  return dimensions(attribute("width"), attribute("height"), attribute("viewBox"));
}

export function validateSvg(data: Uint8Array): void {
  const expected = svgDimensions(data);
  check(typeof DOMParser !== "undefined", "この端末ではSVGの検証APIを利用できません");
  const doc = new DOMParser().parseFromString(svgText(data), "image/svg+xml");
  const root = doc.documentElement;
  check(!doc.querySelector("parsererror") && root.localName === "svg" &&
    root.namespaceURI === SVG_NAMESPACE, "SVGのXMLまたは名前空間が不正です");
  const actual = dimensions(root.getAttribute("width"), root.getAttribute("height"), root.getAttribute("viewBox"));
  check(actual.width === expected.width && actual.height === expected.height, "SVGの寸法が不正です");
  const nodes = doc.getElementsByTagName("*");
  check(nodes.length <= 10000, "SVGの要素数が10000件の上限を超えています");
  const ids = new Map<string, Element>();
  const uses: Element[] = [];
  for (const node of Array.from(nodes)) {
    check(node.namespaceURI === SVG_NAMESPACE && elements.has(node.localName),
      `SVGの要素 ${node.localName} は未対応です`);
    const id = node.getAttribute("id");
    if (id) { check(!ids.has(id), "SVGのIDが重複しています"); ids.set(id, node); }
    if (node.localName === "use") uses.push(node);
    for (const attr of Array.from(node.attributes)) {
      check(!/^on/i.test(attr.localName) && !["style", "base"].includes(attr.localName),
        "SVGのイベント、CSS、ベースURLは未対応です");
      check(!attr.namespaceURI || attr.namespaceURI === "http://www.w3.org/2000/xmlns/" ||
        attr.namespaceURI === "http://www.w3.org/1999/xlink" && attr.localName === "href" ||
        attr.namespaceURI === "http://www.w3.org/XML/1998/namespace" &&
          ["space", "lang"].includes(attr.localName), "SVGの属性名前空間は未対応です");
      if (attr.localName === "href")
        check(/^#[A-Za-z_][\w.:-]*$/.test(attr.value), "SVGの外部参照は読み込めません");
      if (/url\s*\(/i.test(attr.value))
        check(/^url\(\s*(['"]?)#[A-Za-z_][\w.:-]*\1\s*\)$/.test(attr.value),
          "SVGの外部参照は読み込めません");
      check(!/\\|@import|javascript:|data:|https?:|file:/i.test(attr.value) ||
        attr.namespaceURI === "http://www.w3.org/2000/xmlns/", "SVGの外部参照は読み込めません");
    }
  }
  // Prevent recursive or exponentially expanding <use> instances.
  for (const use of uses) {
    const href = use.getAttribute("href") ?? use.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    const target = href ? ids.get(href.slice(1)) : undefined;
    check(target && !["use", "svg"].includes(target.localName) &&
      target.getElementsByTagNameNS(SVG_NAMESPACE, "use").length === 0,
    "SVGのuseは単純な内部参照のみ対応しています");
  }
}

export function svgDataUrl(text: string): Uint8Array {
  check(text.length <= 90_000_000, "64 MiBを超えるSVGデータURLは追加できません");
  const match = text.trim().match(/^data:image\/svg\+xml(?:;charset=utf-8)?(;base64)?,([\s\S]*)$/i);
  check(match, "SVGデータURLの形式が不正です");
  let data: Uint8Array;
  try {
    if (match[1]) {
      const encoded = match[2].replace(/\s/g, "");
      check(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded),
        "SVGデータURLのBase64が不正です");
      data = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
    } else {
      const encoded = match[2];
      const bytes = new Uint8Array(encoded.length);
      let count = 0;
      for (let i = 0; i < encoded.length; i++) {
        if (encoded[i] === "%") {
          check(/^[0-9a-f]{2}$/i.test(encoded.slice(i + 1, i + 3)), "SVGデータURLのエスケープが不正です");
          bytes[count++] = parseInt(encoded.slice(i + 1, i + 3), 16); i += 2;
        } else {
          check(encoded.charCodeAt(i) < 128, "SVGデータURLは非ASCII文字をパーセント符号化してください");
          bytes[count++] = encoded.charCodeAt(i);
        }
      }
      data = bytes.slice(0, count);
    }
  } catch (error) {
    throw new Error(`SVGデータURLを展開できません: ${error instanceof Error ? error.message : String(error)}`);
  }
  check(data.length <= 64 * 1024 * 1024, "64 MiBを超えるSVGは追加できません");
  check(looksLikeSvg(data), "データURLにSVGが含まれていません");
  return data;
}

export async function decodeSvg(data: Uint8Array, signal: AbortSignal): Promise<ImageBitmap> {
  signal.throwIfAborted();
  validateSvg(data);
  const { width, height } = svgDimensions(data);
  const url = URL.createObjectURL(new Blob([Uint8Array.from(data)], { type: "image/svg+xml" }));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); image.src = ""; reject(signal.reason); };
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(new Error("この端末でSVGを展開できません")); };
      signal.addEventListener("abort", abort, { once: true });
      image.width = width; image.height = height; image.src = url;
    });
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    try {
      const context = canvas.getContext("2d");
      check(context, "SVG描画用のCanvasを作成できません");
      context.drawImage(image, 0, 0, width, height);
      const bitmap = await createImageBitmap(canvas);
      if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
      return bitmap;
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { image.src = ""; URL.revokeObjectURL(url); }
}
