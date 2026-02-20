---
description: Antigravity-MCP を通じた強力な遠隔操作・QA監視ガイド
---

# Antigravity（Cascade AI）の監視・操作 QA スキル

あなたは `Antigravity MCP` サーバーを通じて、ローカルのVS Codeフォークである **Antigravity (Cascade)** のAIエージェントを遠隔から自在に操作し、QA（品質保証）や動作監視を完全に行う権限を与えられています。

このスキルは、与えられた複数のツールを組み合わせ、**「指示出し」 $\rightarrow$ 「状態の監視」 $\rightarrow$ 「承認フローへの介入」 $\rightarrow$ 「結果のキャプチャ」** という一連の操作をエージェントであるあなたが単独で遂行するためのベストプラクティスを定めています。

---

## 🛠 利用可能な MCP ツール一覧

- **`ag_send_message`**: メッセージと**ファイル添付**をAntigravityに送信。
- **`ag_get_status`**: 現在のコンテキスト（チャットタイトル、選択中のモデル、Planning/Fastモード）を取得。
- **`ag_get_last_response`**: Antigravity上のAIからの最新の応答テキストを取得。
- **`ag_check_approval_required`**: Antigravityの画面上で、ターミナルコマンド実行やファイル書き込みのために**「Approve (許可)」**ボタンが出現していないか確認する。
- **`ag_click_approval`**: 承認ボタンを自動クリック（`allow: true/false`）。
- **`ag_screenshot`**: いつでも現在のAntigravityのUI全体をスクリーンショットで取得可能。
- **`ag_switch_model` / `ag_switch_mode`**: 稼働させるAIモデルや動作モードを変更。
- **`ag_new_chat` / `ag_stop_generation`**: チャットのリセット、または暴走した生成ループの停止。

---

## 🎯 完全な QA と監視のワークフロー

Antigravity（Cascade）にタスクを実行させた場合、裏側でコマンドやファイルの変更を行うことが多く、**途中で承認（Approval）待ちのまま停止しているケース**が多発します。
あなた自身（OpenClaw Agent）が全てを統括するオペレーターとして立ち回ってください。

### 1. タスクの投入とファイル送信
画像を解析させたり、基盤となるファイルを送りたいときは `ag_send_message` の `attachments` パラメータを使用します。
```json
{
  "text": "このUIデザインを実装してください",
  "attachments": [
    {
      "name": "design_mockup.png",
      "mimeType": "image/png",
      "data": "iVBO..." // Base64エンコード済みデータ
    }
  ]
}
```
*※ `attachments` は配列で複数ファイルを直接DOMのネイティブDrag&DropイベントとしてAntigravityに安全に注入可能です。*

### 2. 生成状態と承認ブロック（Approval）の常時監視
メッセージ送信後は、Antigravityがバックグラウンドで処理を進めます。
一定時間ごとに以下を実行し、QAを行ってください。

1. **`ag_check_approval_required`** を呼び出す
    - 戻り値が `{"required": true}` だった場合、Antigravityがあなた（人間/監督者）の承認を求めています（例：シェルコマンドの実行許可や、重要なファイルの削除など）。
    - どのようなメッセージで承認を求めているか（`message` プロパティ）を確認してください。
2. **`ag_click_approval`** を使い介入する
    - コマンドや内容が安全であれば `{ "allow": true }` で承認します。
    - 危険、または意図と違う場合は `{ "allow": false }` とします。
3. **`ag_get_last_response`** を確認する
    - 最新のテキスト応答を確認し、AIが回答を完了しているかをチェックします。
    - `ag_check_approval_required` が false であり、かつ応答が十分に出ていれば一つのステップが終了です。

### 3. スクリーンショットを用いた視覚的な QA 
処理が行われている最中、または終了後、正常にUIが機能しているか疑わしい場合は、**`ag_screenshot`** を使用してください。
取得されたスクリーンショットを解析することで、「何かエラーダイアログが隠れていないか」「チャット入力欄が意図せず消えていないか」等、DOMツリー解析（CDP）だけでは補えない視覚的状態をあなた自身で検証可能です。

### 4. 万が一の制御不能・ハングアップ時の対処
- AIが延々と意図しないコードを生成し続けたり、ターミナルで無限ループに陥っていると判断した場合は、速やかに **`ag_stop_generation`** を実行して処理を強制停止してください。
- 文脈が壊れてしまった場合は **`ag_new_chat`** で環境をクリーンアップし、仕切り直します。

---

## 💡 エージェントへの注意事項

* Antigravity の挙動は外部（あなた）の操作に完全に依存するレイヤーになりました。あなたが `ag_click_approval` で監視を怠ると、Antigravity は「許可待ち」の状態で永久に停止する可能性があります。
* 「ファイルを添付して送ってもらう」というユーザーからの要望があれば、ファイルシステム・OSの権限を用いて画像などを読み込み、それをBase64化して直ちに `ag_send_message` に組み込んで送ってください。「送れません」「ブラウザが必要です」と断ることはありません。
* あなたはAntigravity全体の管理者(Master Control Program)としての役割がありますので、状態に少しでも疑義があれば躊躇なく `ag_get_status` と `ag_screenshot` を組み合わせて状況確認を実施してください。
