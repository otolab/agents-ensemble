# ADR 0033: 稼働中 Open Question の UDS control API

- Status: accepted
- Date: 2026-10-20
- Related: [ADR 0008](0008-human-dialogue-open-questions.md), [ADR 0011](0011-session-sidecar-resume.md), [ADR 0031](0031-operator-agent-layer.md), [Issue #480](https://github.com/otolab/agents-ensemble/issues/480), [Issue #481](https://github.com/otolab/agents-ensemble/issues/481)

## Context

Open Question の保存・resume・読み取りは #480 の `open-questions.yaml` を正本とする。一方、YAML の file watch は書き込みと稼働中 `OpenQuestionRegistry` の競合を解決しない。別プロセスの operator-agent が稼働中セッションの質問を読み、回答を harness に渡すには、セッション単位のライブ control 面が必要である。

`ensemble issue` は長い repository path で実行されることがあり、macOS の Unix domain socket pathname 上限より `.ensemble/sessions/{conductorAgentId}/harness.sock` が長くなる。接続先は session sidecar に記録し、operator-agent はその path を読む client に限定する。

## Decision

### 所有権と transport

- UDS server は `runConductorSession` 内の harness がセッションごとに起動・停止する。operator-agent は server を起動せず、sidecar に記録された path を使う client とする。
- socket は `mkdtemp` で作る owner-only runtime directory に置く。実際の socket path を JSON sidecar の `harnessSocketPath` に記録し、teardown 時に listener と runtime directory を削除して sidecar から path を外す。長い repository path に依存しない。
- `.ensemble/sessions/` とセッションデータ directory は owner-only (`0700`)、sidecar・YAML・socket は owner read/write (`0600`) とする。認証 token は設けず、同じ OS user のプロセスだけが接続できる前提とする。
- transport は JSON-RPC 2.0 の newline-delimited JSON。1 connection につき request / response を各 1 件とし、method 名と versioned JSON-RPC envelope を将来の control method に再利用する。

### 初期 API sketch

```json
{"jsonrpc":"2.0","id":1,"method":"open_questions.list","params":{}}
{"jsonrpc":"2.0","id":1,"result":{"questions":[{"id":"inq-1","question":"Proceed?","responseType":"yes_no","context":"Release decision","choices":[],"askedAt":1735689600000,"source":"conductor","relatedPermissionId":"perm-1"}]}}
```

`open_questions.list` は稼働中 Registry の `status: open` のみを返す。各項目は `id`, `question`, `responseType`, `choices`, `context`, `askedAt`, `source`, `relatedPermissionId`（存在時）に限る。

```json
{"jsonrpc":"2.0","id":2,"method":"open_questions.answer","params":{"questionId":"inq-1","answer":"yes"}}
{"jsonrpc":"2.0","id":2,"result":{"question":{"id":"inq-1","status":"answered","answeredBy":"operator","approved":true}}}
```

`open_questions.answer` は open question のみ受け付ける。harness は既存 `submitOperatorInput` / `recordOpenQuestionAnswer` 経路で `answeredBy: operator`、yes/no・choice 解釈、permission 連携、escalation 記録を行い、既存 event queue に `operator.message` 相当を積む。YAML と JSON sidecar の flush が終わってから成功 response を返す。質問が無い・すでに回答済み・harness が停止中・要求に失敗した場合は error を返し、YAML 等への fallback はしない。

### 情報露出とログ

- API は質問・context・選択肢を保存値のまま返す。任意文面から secret や repository 外情報を確実に識別する一般的な redactor は設けないため、これらを機密になりうる operator data として扱い、要求された allowlist 外の repository / worker / environment 情報は追加しない。
- UDS server は request / response body をログに書かない。既存 CLI の operator observation は従来どおり質問本文・回答本文を表示する。sidecar と YAML にも回答済み本文を保存するため、owner-only permissions を適用する。

### 自動解決

自動解決は本 API に含めない。将来追加する場合は resolver policy と `answeredBy` の権限上の意味を別途決める。初期 API に system actor や暗黙の operator 代理回答は設けない。

## Consequences

- 良い: 同じ Registry と回答経路を使うため、ライブ一覧、回答、permission-linked `approved`、YAML、conductor dispatch の状態が一つに揃う。JSON-RPC method を増やす余地も残る。
- 悪い: 同一 OS user のプロセスは socket に接続できる。質問と回答は保存値のまま返り、既存 CLI observation にも本文が残る。UDS path はプロセス寿命のみ有効で、停止中の読み書きはできない。
- 対象外: YAML file watch、固定 TCP、未稼働時の自動 fallback、GitHub コメント同期、自動解決。
