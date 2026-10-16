<?php
// 計測APIの設定。サーバーでは public_html の外（shitsurae-data/config.php）に置く。
// このファイルを config.local.php にコピーして値を入れる。config.local.php はGitに入れない（公開リポジトリのため）。
return [
    // 計測を受け付けるページの出どころ（ブラウザのOriginヘッダと一致するもの）
    'allowed_origins' => [
        'https://gearbox00.github.io',
    ],
    // 連打よけのハッシュに混ぜる塩。長い無作為な文字列にする（例: openssl rand -hex 24）
    'salt' => 'ここに長い無作為な文字列',
    // 集計画面を見るためのキー。URLに ?key= として付ける（例: openssl rand -hex 16）
    'stats_key' => 'ここに別の無作為な文字列',
];
