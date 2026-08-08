# 作業フロー（参考）

固定フローではなく、オーケが文脈で判断するための参考フレーム。

```
① 作業 (implementer)
② Issue 更新 (implementer)
③ PR 作成 (implementer)
   └─ (条件付き) ドキュメント整備
④⑤ PR レビュー・投稿 (reviewer)
⑥⑦ レビュー対応・確認 (implementer ⇄ reviewer) … ループ
⑨ 人間レビュー依頼 (implementer)
⑩ レビュー・マージ (人間)
⑪ Issue 報告・クローズ (implementer)
   └─ スキル改善
```

## 向いている Issue

- 手順が Skill または Issue に書いてある
- 1 Issue = 1 作業単位
- 完了条件が明確

## 参照実例

- `config-checker-fix` / `config-checker-fix-review`（karte-io-systems）
