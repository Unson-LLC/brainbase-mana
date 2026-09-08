# DMの受付・進行表示

## 原因と境界

Company Authorityの通常返信経路は単一の返信を所有し、共有pipelineのSlack書込みを拒否する。共有pipelineはその経路でreactions.add/removeとassistant.threads.setStatusを実行するため、上流へ届く前に拒否される。

## 修正方針

既存の操作別Slack delivery portを利用し、受付操作を通常返信と別のeffectとして解決する。元の認証済み依頼のtenant、workspace、actor、project、channel、message/threadとの対応を保持する。

送信可能な操作はPOSTのreactions.add/remove（eyes）とassistant.threads.setStatus（既存の処理中表示または空文字）だけとする。URL query、別host/path、別method、別宛先、余分なbody項目を通さず、検証後の値から新しいRequestを作る。通常のchat.postMessageは既存postReplyに残す。

操作IDは元イベントと表示操作から安定して導出する。追加・削除・表示・解除を区別し、所有権によって同一effectの再送を防ぐ。状態表示は90秒の時刻区間を操作IDへ含め、同一区間の再試行を抑えながら既存の90秒更新を実送信する。

## 診断

受付失敗の既存イベントに、固定allowlistの認可コード、境界、HTTP状態、通信失敗の区分を残す。未知の値はunknownにし、Error.messageや任意detailsを出さない。診断と表示失敗は通常返信の成否を変更しない。

## 検証

- 現行経路が受付操作を拒否する失敗テストから修正後の成功を確認する。
- 既存reply所有権、別宛先、未知操作、body追加、query、method、重複を検証する。
- 認可拒否の保持と秘密値を含む例外の非出力を検証する。
- 本番では元DMの受付表示を観測し、処理後の解除と同一スレッドへの返信1件を読戻す。検索E2Eを再生成しない。

## 実装時の検証結果

元のindex.tsで新しい受付成功テストがAUTHORITY_SCOPE_MISMATCHにより失敗することを確認した。診断テストは修正前5件失敗から成功へ変わった。受付・返信・既存配線の160件とcloud-runtime型検査が成功。本番の表示開始・解除は配備後に確認する。

## Company Authorityの引継ぎ

本番の受付検証で、旧tenant-context再取得がcompany_authority_v1を保持せず、厳密な権限比較で拒否されることを確認した。受付操作では元のCompany Authority依頼からdelivery.event_idと操作別のcorrelation_idを決定的に派生させ、同じ本人・対象・権限・効果で署名済み情報を取り直す。元の権限集合との比較は維持し、判定がauto以外なら外部操作を実行しない。

本番と同じcapability集合を持つテストで旧経路の拒否を再現した。修正後は受付操作が成功し、元依頼の引継ぎ、本人・プロジェクト・追加権限の変化の拒否、署名済みapproval/human_action判定の拒否を検証する。

## 操作ごとの接続情報

Company Authorityで署名済み情報を取り直した後も、受付操作が情報を持たない別のHTTPクライアントを参照していた。そのためSlack送信前のworkspace connection検証がWORKSPACE_CONNECTION_UNAVAILABLEで停止した。

各操作のクライアントは、その操作で検証したtenant contextを持つ。接続revision照合、credential lease、quota、accountingは同じ操作のクライアントを使用する。共有キャッシュへの差し替えで操作間の情報を混在させず、既存の権限比較も維持する。

実HTTPクライアントの接続照合で未設定contextを拒否する回帰テストを追加した。旧実装でWORKSPACE_CONNECTION_UNAVAILABLEを再現し、修正後は4操作それぞれのcontextが接続照合へ送られ、別の操作と混在しないことを確認した。関連189件が成功した。診断はworkspace_connectionと既知のUNAVAILABLE／STALE_REVISIONを保持し、任意の例外文を出さない。
