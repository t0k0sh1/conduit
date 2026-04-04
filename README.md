# conduit

Tauri 2 デスクトップアプリ。**Node.js / npm は使用しません**（ビルド・CLI は Rust のみ）。

## 必要なもの

- [Rust](https://rustup.rs/)（stable）
- Tauri CLI（初回のみ）:

```sh
cargo install tauri-cli --locked
```

## 開発

リポジトリのルートで:

```sh
cargo tauri dev
```

（`src-tauri` ディレクトリ内から実行しても同じです。）

Rust 側のみのビルド確認:

```sh
cargo build
```

## リリースビルド

```sh
cargo tauri build
```

成果物は `target/release/bundle/` 以下に生成されます。

## 構成

- `src/` — WebView 用の静的ファイル（HTML / CSS / JavaScript）。ビルドツールは使っていません。
- `src-tauri/` — Rust（Tauri 本体・コマンド）
- ルートの `Cargo.toml` — ワークスペース定義

フロントの依存関係に npm は含まれません。表示用マークアップとスタイルは `src/` に置いたまま、ロジックは Rust の `invoke` で足していく形が推奨です。
