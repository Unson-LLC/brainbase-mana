---
story_id: story-google-drive-write-e2e
title: Google Drive Inline File Creation Spec
status: accepted
architecture_docs:
  - docs/operations/google-drive-mcp.md
---

# Google Drive Inline File Creation Spec

## Tool contract

`google-drive.create_file`は次を受け取る。

- `name`: 必須のDriveファイル名
- `content`: UTF-8テキスト本文。`contentBase64`と排他
- `contentBase64`: バイナリ本文のbase64表現。`content`と排他
- `parentId`: 任意の保存先フォルダID
- `mimeType`: 任意。省略時はテキスト本文を`text/plain; charset=utf-8`、base64本文を`application/octet-stream`として扱う

inline本文はdecode後20 MiB以下に制限する。不正または曖昧な入力は、認証確認後かつDrive書き込み前にエラーとする。

## Upload implementation

MCP server自身がOS temporary directory内に権限`0600`の一時ファイルを作り、既存のGoogle Workspace CLI `drive files create --upload`へ渡す。処理の成功・失敗にかかわらず一時ディレクトリを削除する。この一時ファイルは信頼されたMCP serverがinline payloadから生成するため、ユーザー指定ローカルパス用の`GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS`検査対象にはしない。

`upload_file`のpath allowlist検査は変更しない。

## Deployment contract

Cloudflare runtimeはSlackチャンネルを`RUNTIME_PLACEMENTS_JSON`のplacementへ解決し、
そのplacementの`capabilities.mcp`に`google-drive`が含まれる場合だけGoogle Drive MCPを
Sandboxへ渡す。`9960-back-office`（`C0BKS6RL99T`）は会計業務でDriveを参照するため、
`mana-accounting` placementにこの権限を明示する。

Workerは`https://google-drive-mcp.internal/mcp`を内部proxyとして扱い、
`GOOGLE_DRIVE_MCP_BASE_URL`とCloudflare secret `GOOGLE_DRIVE_MCP_TOKEN`を使って
Brainbase側のGoogle Drive MCPへ転送する。tokenの正本はInfisicalの
`GOOGLE_DRIVE_MCP_HTTP_BEARER_TOKEN`とし、本番反映時にwrapper経由でCloudflare secretへ投影する。

## Response and failure contract

Google Workspace CLIのJSON応答をそのまま返し、少なくとも要求するfieldsに`id,name,mimeType,webViewLink,parents`を含める。CLIが失敗した場合はMCP errorとし、ファイルIDやリンクを合成しない。

## Verification

- Unit: tool公開、入力排他、不正base64、size limit、MIME type既定値
- Integration: fake Google Workspace CLIに渡るmetadata、upload bytes、成功応答、一時ファイルcleanup、およびbuild済みserverへの`initialize`/`tools/list`
- Regression:既存Google Drive MCP tests、package typecheck、build
- Deploy: 通常activationとrollback後に固定MCPパスがactive releaseへ解決されること
- Production E2E: Slack依頼からDrive実ファイル作成、ID/link取得、同一thread返信
