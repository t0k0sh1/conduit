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

## ローカル PostgreSQL（Docker Compose）

```sh
docker compose up -d
```

ルートの `compose.yaml` では `postgres-a` がホストの **15432**、`postgres-b` が **25432** にマッピングされています。ユーザー名・データベース名は `postgres`、パスワードは `postgres` です。接続プロファイルの例: Host `localhost`、Port `15432` または `25432`、Database `postgres`、User `postgres`、Password `postgres`。

**Save password in profile** をオンにするとパスワードがプロファイルに保存されます。オフの場合は接続を開くときにパスワード入力ダイアログが表示され、その値はメモリにのみ保持されディスクには保存されません。
