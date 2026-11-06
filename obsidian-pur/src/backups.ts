import { check } from "./binary";
import { sameBytes } from "./save-copy";

export interface BackupRecord { source: string; path: string; sha256: string; blocked?: boolean }
export interface BackupStore {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  create(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string, expected: Uint8Array): Promise<void>;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

function recordsFrom(value: unknown): BackupRecord[] {
  if (value === undefined) return [];
  check(Array.isArray(value), "バックアップ管理情報が不正です。data.jsonを退避して確認してください");
  const paths = new Set<string>();
  return value.map((record: unknown) => {
    check(typeof record === "object" && record !== null &&
      "source" in record && typeof record.source === "string" &&
      "path" in record && typeof record.path === "string" &&
      "sha256" in record && typeof record.sha256 === "string", "バックアップ管理情報が不正です");
    check(
      /\.pur\.lazyref-managed-[0-9a-f-]{36}\.bak$/i.test(record.path) &&
      ![record.source, record.path].some(path => path.startsWith("/") || path.split("/").some(part =>
        !part || part === "." || part === ".." || /[\\:\u0000-\u001f]/.test(part))) &&
      /^[0-9a-f]{64}$/.test(record.sha256) && !paths.has(record.path),
    "バックアップ管理情報が不正です。登録外のファイルは操作しません");
    paths.add(record.path);
    check(!("blocked" in record) || typeof record.blocked === "boolean", "バックアップ管理情報が不正です");
    return { source: record.source, path: record.path, sha256: record.sha256,
      ...("blocked" in record && record.blocked === true ? { blocked: true } : {}) };
  });
}

/** Only recorded, verified copies belong to the rotation; filename matching is never discovery. */
export class PurBackups {
  private records: BackupRecord[];
  private queue: Promise<unknown> = Promise.resolve();
  private blocked = new Set<string>();

  constructor(value: unknown, private persist: (records: BackupRecord[]) => Promise<void>) {
    this.records = recordsFrom(value);
    for (const record of this.records) if (record.blocked) this.blocked.add(record.source);
  }

  snapshot(): BackupRecord[] { return this.records.map(record => ({ ...record })); }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async replace(records: BackupRecord[]): Promise<void> {
    await this.persist(records.map(record => ({ ...record })));
    this.records = records;
  }

  rename(oldPath: string, path: string): Promise<void> {
    return this.serial(async () => {
      const moved = this.records.filter(record => record.source === oldPath || record.source.startsWith(`${oldPath}/`));
      if (!moved.length && !this.records.some(record => record.path.startsWith(`${oldPath}/`))) return;
      const destination = (source: string) => path + source.slice(oldPath.length);
      if (moved.some(record => this.records.some(other =>
        !moved.includes(other) && other.source === destination(record.source)))) {
        const affected = new Set(moved.flatMap(record => [record.source, destination(record.source)]));
        for (const source of affected) this.blocked.add(source);
        await this.replace(this.records.map(record => affected.has(record.source) ? { ...record, blocked: true } : record));
        throw new Error(`改名先に別のバックアップ管理情報があります: ${path}。コピーは削除せず保存を中止します`);
      }
      try {
        await this.replace(this.records.map(record => ({
          ...record,
          source: moved.includes(record) ? destination(record.source) : record.source,
          path: record.path.startsWith(`${oldPath}/`) ? destination(record.path) : record.path,
        })));
        for (const record of moved) if (record.blocked) this.blocked.add(destination(record.source));
      } catch (error) {
        for (const record of moved) this.blocked.add(destination(record.source));
        throw error;
      }
    });
  }

  prepare(store: BackupStore, source: string, bytes: Uint8Array, current: () => boolean): Promise<string> {
    return this.serial(async () => {
      check(!this.blocked.has(source), "改名時のバックアップ管理更新に失敗したため保存できません。別名保存を使い、診断を確認してください");
      const sha256 = await digest(bytes);
      for (const record of this.records.filter(record => record.source === source && record.sha256 === sha256)) {
        if (await store.exists(record.path)) {
          check(sameBytes(bytes, await store.read(record.path)), `復旧用コピーが外部変更されています: ${record.path}`);
          check(current(), "バックアップ確認中にファイルまたはビューが変更されました");
          return record.path;
        }
      }
      check(current(), "バックアップ作成前にファイルまたはビューが変更されました");
      const path = `${source}.lazyref-managed-${crypto.randomUUID()}.bak`;
      check(!await store.exists(path), `バックアップ名が既存ファイルと競合しました: ${path}。上書きしません`);
      try {
        await store.create(path, bytes);
        check(sameBytes(bytes, await store.read(path)), "バックアップの再読込結果が一致しません");
        // Persist ownership before touching the source, including for interrupted saves.
        await this.replace([...this.records, { source, path, sha256 }]);
        check(current(), "バックアップ作成中にファイルまたはビューが変更されました");
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}。元ファイルは書き換えていません。` +
          `バックアップ候補: ${path}。不完全または管理未登録の可能性があるため自動削除しません`);
      }
      return path;
    });
  }

  prune(store: BackupStore, keep: string): Promise<void> {
    return this.serial(async () => {
      const latest = this.records.find(record => record.path === keep);
      check(latest, `バックアップ管理情報がありません: ${keep}`);
      check(!latest.blocked && !this.blocked.has(latest.source), `改名時の管理情報が競合しています: ${latest.source}。削除しません`);
      check(await digest(await store.read(keep)) === latest.sha256, `直前の復旧用コピーが変更されています: ${keep}`);
      for (const record of this.records.filter(record => record.source === latest.source && record.path !== keep)) {
        if (await store.exists(record.path)) {
          const bytes = await store.read(record.path);
          check(await digest(bytes) === record.sha256, `古い復旧用コピーが外部変更されています: ${record.path}。削除しません`);
          check(await digest(await store.read(keep)) === latest.sha256, `直前の復旧用コピーが変更されています: ${keep}`);
          await store.remove(record.path, bytes);
          check(!await store.exists(record.path), `古い復旧用コピーを削除できませんでした: ${record.path}`);
        }
        await this.replace(this.records.filter(value => value.path !== record.path));
      }
    });
  }
}
