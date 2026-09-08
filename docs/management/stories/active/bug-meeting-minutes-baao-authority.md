# BAAOの保存先選択が生成開始前に止まる不具合

## 利用者価値

BAAO GrowinまたはBAAOの保存先を選んだ利用者が、登録済みの正規プロジェクトとして権限判定を受け、議事録生成へ進めるようにする。

## 原因と仕様

2026-09-08 09:18 JSTのGrowin操作は、worker_ingressのPROJECT_SCOPE_MISMATCHでキュー投入前に拒否された。呼び出し全体は136ms。本番設定の読み戻しで、保存先のcontextProjectCode=baaoに対応するMEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSONの項目がないことを確認した。

Brainbase正本scripts/normalize-graph-data-ssot.mjsのbaaoProjectEntityに合わせ、baaoをprj_01KGCS8BC76XRHFCHRRQ8G25MYへ対応付ける。テナント・利用者の認可処理は引き続き実行する。

## 受け入れ条件

- baao-growinとbaaoの保存先が同じ正規Authorityプロジェクトへ解決される。
- 設定からbaao対応を削除すると回帰テストが失敗する。
- 本番反映後に設定実値を読み戻す。実際の生成・保存・Slack共有は設定反映と区別して確認する。

## 検証範囲

保存先設定のテストと選択スコープのテストを実行する。本番配備は既存の認可・事前検証手順を使う。受付通知だけを生成成功と扱わない。
