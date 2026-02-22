# Antigravity Remote
**Discord Bot & MCP Server for Antigravity (VS Code Fork / Cascade AI)**

Antigravity REPL / AI エージェント（Cascade）を外部から遠隔操作・監視するための統合ツールです。
このリポジトリには、Discord から Antigravity を操作するための **Bot サーバー** と、OpenClaw Agent 等から直接機能を呼び出すための **MCP サーバー** の両方が含まれています。

---

## 🚀 主な機能

### 1. MCP サーバー (`server_mcp.js`)
LAN内で `OpenClawAgent` などの MCP クライアントから直接 Antigravity を操作・監視します。
- URL: `http://localhost:3000/sse` (ポートは `.env` の `MCP_PORT` で変更可能)
- サポートするツール:
  - **🗣️ メッセージ・ファイル送信 (`ag_send_message`)**: 
    - テキストに加え、画像や軽量ファイルを `attachments` として直接注入可能。
    - **【重要】同期通信（Synchronous Chat）対応**: コマンド実行後、Antigravity（Cascade）が返答を生成し終わるまで待機し、生成されたテキストを**ツールの返り値として直接**エージェントに返します（重力通信の真の開通）。
  - **状態監視**: `ag_get_status` (モデル状態・現在のワークスペース名), `ag_get_last_response` (直近の応答内容を手動取得)
  - **承認の自動化**: `ag_check_approval_required`, `ag_click_approval` (コマンド実行やファイル変更等の確認ダイアログの検知とクリック)
  - **制御**: `ag_switch_model`, `ag_switch_mode`, `ag_new_chat`, `ag_stop_generation`
  - **視覚確認**: `ag_screenshot` (AntigravityのUI全体をキャプチャ)

### 2. Discord ボット (`server_discord.js`)
Discord チャンネルを介して人間が Antigravity に指示を出したり、AIの出力をモニタリングできます。
- **ファイル添付**: Discordに画像を貼り付けると自動でダウンロード＆添付されます。
- **通知自動化**: 生成中ステータス、AIからの応答、ファイルの作成・更新・削除を自動通知。
- **操作コマンド**: `/model`, `/mode`, `/screenshot`, `/stop`, `/newchat` などを備えています。

---

## 🛠️ 事前準備 \& インストール

1. レポジトリをクローンし、依存関係をインストールします。
   ```bash
   npm install
   ```
2. `.env` ファイルを設定します（Discordボットを使う場合のみ必須）。
   ```env
   DISCORD_BOT_TOKEN="あなたのDiscord Botトークン"
   DISCORD_ALLOWED_USER_ID="あなたのDiscordのユーザーID"
   WATCH_DIR="C:/path/to/your/workspace" # (任意)
   MCP_PORT=3000
   MCP_HOST=0.0.0.0
   ```

## 🎮 起動方法

Antigravity を起動する際は必ず **Remote Debugging** を有効にしてください。
ショートカットの「リンク先」の末尾に `--remote-debugging-port=9222` を追加した上で起動が必要です。

**🔹 シナリオ A: MCP サーバー（OpenClaw Agent連携）のみを使う**
```bash
npm run mcp
```

**OpenClaw Agent 側の設定 (openclaw.json)**
OpenClaw の設定ファイルに以下のエンドポイントを追加することで、エージェントは自動的にツール群を認識します。
```json
{
  "mcpServers": {
    "antigravity": {
      "command": "http://<AntigravityPCのローカルIP>:3000/sse",
      "transport": "sse"
    }
  }
}
```
*※ LAN越し（別PC）から接続する場合は `localhost` ではなく、Antigravityが稼働しているPCの実際のローカルIPアドレス（例：`192.168.1.5`）を指定してください。*

**🔹 シナリオ B: Discord Bot を使う**
```bash
npm run start
```

*(バックエンドである `cdp_service.js` が、動作中のAntigravityへ自動接続して処理を実行します)*

## ⚠️ セキュリティに関する注意
ローカル内で動いている強力なAI（ファイル操作やコマンド実行権限を持つ）を遠隔から操作するツールです。
MCPサーバーは `.env` ファイルで `MCP_HOST=127.0.0.1` に設定することで、意図しないLANからのアクセスを防ぐことができます。
また、Discord機能を使う場合は、`.env` で特定のユーザーIDを必ず指定し、第三者に悪用されないように保護してください。
