import { check } from "./binary";
import { sameBytes } from "./save-copy";

export interface OverwriteStore {
  read(): Promise<Uint8Array>;
  backup(bytes: Uint8Array): Promise<string>;
  write(bytes: Uint8Array): Promise<void>;
}

export async function overwriteVerified(
  store: OverwriteStore, source: Uint8Array, output: Uint8Array, current: () => boolean,
): Promise<string> {
  const ensureCurrent = async () => {
    check(current(), "ファイルが削除、改名されたか、ビューが切り替わったため保存を中止しました");
    check(sameBytes(source, await store.read()), "外部更新を検出したため上書きしません");
    check(current(), "ファイルまたはビューが変更されたため保存を中止しました");
  };
  await ensureCurrent();
  const backup = await store.backup(source);
  try {
    await ensureCurrent();
    await store.write(output);
    check(sameBytes(output, await store.read()), "保存後の再読込結果が一致しません");
    check(current(), "保存中にファイルまたはビューが変更されました");
    return backup;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}。保存を完了扱いにしていません。` +
      `元データの復旧用コピー: ${backup}。現在のファイルは変更済みまたは不完全な可能性があります。自動復元はしていません`);
  }
}
