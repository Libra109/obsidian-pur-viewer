import { check } from "./binary";

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function copyPath(sourcePath: string, name: string): string {
  check(name === name.trim() && name.length > 4 && /\.pur$/i.test(name) &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !name.startsWith(".") &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(name), "保存名はフォルダーを含まない有効な .pur ファイル名にしてください");
  const slash = sourcePath.lastIndexOf("/");
  const path = sourcePath.slice(0, slash + 1) + name;
  check(path.toLowerCase() !== sourcePath.toLowerCase(), "元ファイルと同じ名前には保存できません");
  return path;
}

export interface CopyStore {
  source(): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  create(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
}

export async function saveVerifiedCopy(
  store: CopyStore, source: Uint8Array, path: string, output: Uint8Array, current: () => boolean,
): Promise<void> {
  const ensureCurrent = async () => {
    check(current(), "ビューまたは編集状態が変わったため保存を中止しました");
    check(sameBytes(source, await store.source()), "元ファイルが外部更新されたため保存を中止しました");
    check(current(), "ビューまたは編集状態が変わったため保存を中止しました");
  };
  await ensureCurrent();
  check(!await store.exists(path), "保存先に既存のファイルがあります。別の名前を指定してください");
  await ensureCurrent();
  try {
    await store.create(path, output);
    check(sameBytes(output, await store.read(path)), "保存先の再読込結果が一致しません");
    await ensureCurrent();
  } catch (error) {
    throw new Error(`別名保存を完了できませんでした: ${error instanceof Error ? error.message : String(error)}。保存先 ${path} にファイルが残っている可能性があります。削除や上書きはしていません`);
  }
}
