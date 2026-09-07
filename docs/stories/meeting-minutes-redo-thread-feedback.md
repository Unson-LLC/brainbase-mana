# 保存先変更の案内を元のスレッドへそろえる

利用者として、保存先のやり直しを確認し、受付と結果を同じスレッドで追いたい。1クリックで複数の途中通知がチャンネル直下に増えないようにする。

## 受け入れ条件

- やり直し確認、要求受付、キュー投入失敗、受付停止、状態表示失敗を、操作した本人への元スレッド内通知として送る。
- SlackへのHTTP応答はtenant解決より先に空の200を返す。redoでは汎用受付と詳細の確認中通知を追加せず、正常時は確認または要求受付を1件送る。
- 通常通知はtenantのSlack配送境界を通し、chat.postEphemeralにchannel/thread_ts/userを明示する。共有されている現在の議事録状態は置き換えない。
- キュー投入後の受付停止もthread_tsを必須にして、元スレッド内に表示する。処理結果を共有ステータスへ反映する既存動作は維持する。
- 元スレッド座標が欠ける操作は拒否し、action_tsやephemeral messageのtsを元スレッドとして代用しない。
- tenant認証が失敗した場合、既存の通知許可コードに限り、署名済みresponse_urlから元スレッドへ汎用エラーを送る。この例外はスレッド参加者にも見えるため、run・ファイル・tenant情報は含めず、問い合わせIDだけを付ける。unknown/mismatchは引き続き通知せず拒否する。
- ワークスペース・プロジェクト選択、古い操作の拒否、GitHub・Task取消条件は変更しない。

## 検証

- 遅いtenant解決中の即時HTTP応答、余分なredo通知の抑止、通常/失敗通知の本人・元スレッド座標、revision継承を回帰テストで確認する。
- transportの実リクエスト先とJSONを検証し、Slack APIのok:falseを成功扱いしない。
- 本番配備と実際のSlack画面での表示確認は分けて報告する。

Slack仕様: https://docs.slack.dev/interactivity/handling-user-interaction/ と https://docs.slack.dev/reference/methods/chat.postEphemeral/ 。response_urlのthread返信はin_channelを必要とするため、通常の個別通知にはchat.postEphemeralを使う。
