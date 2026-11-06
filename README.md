# LazyRef

A free image reference board that reads and writes PureRef `.pur` files. Android-first, in Rust.

[![CI](https://github.com/achrllrogia45/LazyRef/actions/workflows/ci.yml/badge.svg)](https://github.com/achrllrogia45/LazyRef/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-stable-orange.svg)](https://www.rust-lang.org)

LazyRef is an open-source reference board: you throw images onto a canvas, arrange them, and keep them around while you work. It speaks PureRef's `.pur` scene format directly, so boards made on the desktop open on your phone and back. File in, file out.

**Android is the target.** What exists today is the format core and a small desktop harness used to develop and test the board logic. The Android app is the next milestone.

![LazyRef board running in the development harness](docs/screenshot.png)

## Status

| Piece | State |
|---|---|
| `purcore` — read/write PureRef 2.x `.pur`, read legacy v1.x | Done, tested against a golden corpus |
| Board core + dev harness (egui desktop) | Pan/zoom prototype, development tool only |
| Android app | Next milestone |

Nothing here is a finished consumer app yet. The format layer is the part that's done and load-bearing.

## Obsidianで直接閲覧する

`.pur` を変換せずに開くプラグインを `obsidian-pur` に追加しました。
画像ボードの表示、パン、ズームに対応し、モバイル向けのタッチ操作も実装しています。
プラグイン内で画像の移動と拡縮、取り消しとやり直しに対応します。
v0.3.0では編集モードを初期状態とし、ボード座標に追従する背景グリッドを表示します。
通常時のツールバーと計測は非表示で、PUR操作メニューやコマンドから操作できます。
v0.3.1では常設の警告と状態もデバッグ表示へ移し、失敗は一時通知します。
保存キーはPURビュー専用スコープで処理し、標準保存とホットキーを重複割当する必要はありません。
v0.3.2ではグリッドの画面上の間隔を48px以上96px未満に抑え、選択枠の四隅と各辺中央に8個の丸ハンドルを表示します。
どのハンドルも対向点を固定して等比拡縮します。
v0.4.0では画像選択時の最前面への移動を追加しました（標準オン）。
PUR操作メニューで切り替えられ、前面化もUndo / Redoと保存に反映します。
形式2.1の編集結果は、復旧用コピーを作成して現在の `.pur` へ上書き保存します。
v0.5.0では、正常保存後の管理バックアップをファイルごとに直前の1世代へ整理します。
v0.6.0では、3秒のアイドル後に自動保存し、ビュー終了時にも最後の保存を試します。
v0.7.0では、自動保存までの待ち時間を設定タブで1～60秒に変更でき、初期値は3秒です。
v0.7.1では設定保存値の読み戻し照合、既存設定の保持、失敗通知の集約を追加しました。
v0.8.0では選択画像の90度回転、角の外側の操作域による自由回転、左右反転と上下反転を追加しました。
変換はUndo / Redo、自動保存、.purへの配置行列書き込みに反映します。
今回の変換を含む出力をPureRef本体で開く実機確認は未実施です。
v0.8.1では回転操作域の表示をなくしてカーソルで示し、拡縮カーソルを画像の向きに合わせました。
拡縮中と回転中も画像をリアルタイムに描画します。
v0.8.2では拡縮と回転の各ポインター移動時にCanvasを同期更新し、操作中の画像描画を確認する回帰検証を追加しました。
v0.8.3ではデバッグモードの診断履歴へ、拡縮と回転ごとのポインター移動数およびCanvas描画数を記録します。
v0.8.4では自動保存タイマーのブラウザー呼び出し時に発生する`Illegal invocation`を修正し、編集状態の通知に失敗しても描画を続けるようにしました。
v0.6.0～v0.8.3の自動保存は実機未確認で、動作していなかった可能性があります。
旧方式の所有不明なコピーは自動削除しません。
別名保存も残しますが、このObsidianプラグインの旧形式1.10読み取りは削除しました。
共有Rustの旧形式対応は変更していません。
対応する形式、制限、導入手順は [日本語README](obsidian-pur/README.md) を参照してください。
v0.1.5で今回の起動と表示の不具合が解消したことを、ユーザーがデスクトップ版Obsidian実機で確認しています。
画像の移動と拡縮、取り消しとやり直しもユーザーがデスクトップ実機で確認しています。
v0.2.0の保存についても、ユーザーから「保存確認が取れました」と報告がありました。
ユーザーから、その保存結果をPureRef本体でも開けたと報告がありました。
v0.3.2のグリッドとハンドルはユーザーから問題なさそうだとの報告がありました。
前面化、保存キー、自動保存、v0.6.0のバックアップ整理を含む上書き保存のObsidian実機動作、Android版は未確認です。
自動保存は編集を設定した時間（初期値3秒、1～60秒）止めると現在の`.pur`へ上書きし、保存が成功した場合だけ未保存状態を解除します。
ビュー終了時も最後の保存を試みますが、Obsidianが非同期終了処理を待たない経路の完了は保証していません。

## What works

- **Reads PureRef 2.x `.pur`** scenes (SQLite-based container), including images, transforms, groups, strokes, notes and metadata.
- **Writes them back byte-for-byte identical.** On our golden-corpus tests, a scene that round-trips through the reader and writer produces the exact original file, checksum included.
- **Reads legacy v1.x `.pur`** files (the older binary format), read-only.
- **Board canvas** with cursor-pinned zoom, panning, and sticker transforms that follow the same semantics as PureRef boards.
- No Qt, no C++ runtime. The core crate pulls in `rusqlite` (bundled SQLite) and `md-5`, and that's it.

## Building

You need [Rust](https://rustup.rs) (stable). Nothing else for the core.

```bash
cargo test -p purcore     # format core: container, blobs, SQLite, legacy reader
cargo test -p lazyref     # board camera + sticker-transform invariants
cargo run  -p lazyref     # development harness (needs a display; works under xvfb-run)
```

The test suite includes golden `.pur` scenes captured from real boards, so the format tests exercise real files, not synthetic ones.

## Layout

```
crates/purcore    .pur format core — container codec, blob codecs, SQLite store, legacy reader
crates/app        board app (egui) — the Android target will reuse this core
docs/FORMAT.md    what actually lives inside a .pur file
```

## The `.pur` format

`docs/FORMAT.md` documents the container layout, the scene schema, and the binary codecs, as implemented and verified by `purcore`'s test suite.

## Roadmap

- [ ] Android app — native board UI, open/save `.pur` through the system file picker, share intents
- [ ] Render image stickers from `.pur` scene data in the board (today the harness draws placeholders)
- [ ] Save-back flow in the app (the core can already write; the app needs the UX around it)
- [ ] Desktop builds (no timeline — Android comes first)

## Credits

LazyRef builds on the work of two projects and thanks both:

- [PureRef-format](https://github.com/FyorDev/PureRef-format) — a Python toolkit for `.pur` files; our reference for format behavior.
- [DroidRef](https://github.com/Ruin0x11/DroidRef) — the Android reference-board app this project is a Rust rewrite of; the board interaction model follows it (including its sticker canvas, adapted from [StickerView](https://github.com/wuapnjie/StickerView)).

LazyRef is not affiliated with PureRef or its authors. "PureRef" is mentioned only to describe file-format compatibility.

## License

MIT — see [LICENSE](LICENSE).
