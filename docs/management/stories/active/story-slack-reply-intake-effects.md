---
story_id: story-slack-reply-intake-effects
title: DMの受付と処理中表示を認可された操作として実行する
status: active
created_at: 2026-09-09
updated_at: 2026-09-09
---

# DMの受付と処理中表示を認可された操作として実行する

## 利用者の目的

SlackでManaへ依頼した利用者として、返答を待つ間に依頼が受け付けられ、処理が進んでいることを確認したい。

## 確認した問題

本番DMの検索・返信・最終監査は連続2回成功した。一方、受付リアクションと処理中表示は両方失敗した。通常返信のCompany Authority経路がSlackの書込みを拒否し、そのAUTHORITY_SCOPE_MISMATCHがslack_api_unavailableへ置き換わっていた。

## 受け入れ基準

- 元のworkspace/channel/message/threadに限り、eyesの追加・削除と既存の処理中表示・解除を実行できる。
- 各表示操作は既存の操作別認可、credential lease、所有権、会計境界を通る。通常返信の所有権と任意Slack書込みの拒否を維持する。
- URL・method・bodyを厳密に検証し、検証した値から送信を組み立てる。未知の操作・別宛先・余分な入力は拒否する。
- 受付、解除、状態更新の操作を区別し、再実行時の重複を抑える。
- 認可拒否と通信失敗を固定コードで区別し、任意エラー文・秘密情報・本文をログへ出さない。
- 表示の失敗が通常返信を妨げない。実本番の最小DMで表示の開始・終了と返信の重複なしを確認する。

## 範囲

受付・進行表示に限定する。完了済みの個人KG fixtureと2回の検索E2Eは再生成しない。Container、credential、Slack scope、Hook設定を変更しない。
