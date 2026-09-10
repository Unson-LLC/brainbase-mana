---
story_id: bug-slack-ambient-triage-mention-boundary
title: "Slackの非対象メッセージへManaが勝手に割り込まない"
status: active
contract_type: bug_fix
source:
  type: production-observation
  id: slack-message-1788970590.101309
related_stories:
  - story-slack-mention-brainbase-judgment
---

# Slackの非対象メッセージへManaが勝手に割り込まない

## 利用者価値

Slack利用者として、Mana宛てではない投稿や通常のチャンネル会話に、Manaが勝手に返信・リアクションしないでほしい。これにより、会話の宛先と権限境界を守り、Manaの回答が必要な依頼だけをBrainbase判断と通常返信へ進められる。

## 受け入れ基準

- [ ] AC1: 明示的なMana `app_mention`と、既存ポリシーで許可されたengaged-threadのメンションなし継続だけが、Brainbase Judgment・回答生成・Slack投稿へ進む。
- [ ] AC2: 通常のチャンネル`message`は、スレッドが過去にManaとの会話中であっても、単独の分類器で`reply`またはリアクションへ昇格しない。
- [ ] AC3: 別のSlack利用者への`<@U...>`または`<@W...>`を含む`message`は、engaged threadであっても返信対象外になる。通常のengaged-thread続き（明示メンションなし）は既存どおり対象にできる。
- [ ] AC4: 返信対象外イベントは、Container、返信生成、Slack投稿、リアクション、共有message delivery claimを実行しない。
- [ ] AC5: 回帰テストでAC1からAC4を固定し、既存の明示的なManaメンションとengaged-thread返信を退行させない。

## 非対象

- Brainbase Judgment Resolverの判断規則、Graphの正本責務、通常の`app_mention`回答内容を変更しない。
- 明示メンションを受けた後の認可、監査、モデル生成、Slack readbackの設計を変更しない。
- 本Storyだけで本番配備または本番Slack E2E完了とは扱わない。

## 証拠境界

コード差分、対象単体テスト、型検査はローカル実装の証拠である。これらだけでは本番Workerの実効設定、Slackイベント配送、利用者に見える返信停止を証明しない。本番反映後は、対象外の通常投稿でContainer・Slack外部作用が0件であることと、明示Manaメンションが同一threadへ1回だけ返信されることを、runtime receiptとSlack readbackで別々に確認する。

## 参照

- [Slackの通常メンション回答をBrainbase判断・正本参照・監査ライフサイクルへ接続する](story-slack-mention-brainbase-judgment.md)
