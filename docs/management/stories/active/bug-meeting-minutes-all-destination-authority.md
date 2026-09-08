# 全議事録保存先のAuthority解決漏れ

## 利用者価値

議事録の全24保存先で、保存先選択・ワークスペース選択・保存先やり直し・タスク操作が同じ正規Authorityへ解決され、特定の保存先だけ生成開始前に止まらないようにする。

## 原因と仕様

保存先の `contextProjectCode` を `MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON` から解決する設定が、BAAO対応後も `zeims`、`aitle`、`senpainurse`、`salestailor`、`kartz` で欠落していた。これらは共通resolverの `destination_authority_project_id_missing` でQueue投入前に拒否される。

Graphで確認した各canonical Authority IDを明示的に設定し、全24保存先を同じresolverで検証する。既存の `techknight` IDと利用者・テナント認可は変更しない。

## 受け入れ条件

- 全24保存先が `prj_...` の正規Authorityへ解決される。
- Authority mapから任意の保存先contextを削除すると回帰テストが失敗する。
- task target、placement、既存の外部処理契約を変更しない。

## 検証範囲

deployment設定テストとresolverテストを実行する。本番配備と実行結果は親タスクの配備・readbackで別途確認する。
