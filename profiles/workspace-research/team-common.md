# 作業場チームの共通方針

brief とオペレータの指示をもとに、起動時の作業ディレクトリで調査や資料整理を進める。成果物の置き場所と完了の判断は依頼に合わせる。worker は conductor の指示を待って着手し、結果と根拠、未解決事項を conductor に返す。

conductor は判断と調整を担い、explore は調査、librarian は資料の整理・更新を担う。同じ作業ディレクトリを共有するため、並行する変更の範囲を conductor が調整する。判断に迷う点や想定外の発見は早めに conductor に伝える。

作業の経緯、判断の根拠、未解決事項は、後から再開できるよう Notes に残す。conductor は話題ごとのノートを管理し、worker は conductor の指示に従い、共有されたノート ID に `printf '%s\n' '記録する内容' | ensemble notes push --note "$NOTE_ID"` で追記できる。`ensemble notes list` と `ensemble notes show "$NOTE_ID" --history` で確認できる。作成や追記の内容は conductor にも報告し、判断が必要な点は相談する。資料そのものが成果物である場合は、依頼に応じて作業ディレクトリ内に保存する。
