<?php
/*
 * しつらえ（3Dシミュレーター）からの計測を受け取る窓口。
 *   POST /shitsurae-api/track.php  本文はJSON {"ev":"view","page":"ring","sid":"...","extra":""}
 *
 * 保存するのは「何が・どのページで・いつ・どの端末種別で」だけ。
 * IPアドレス・氏名・端末IDなどの個人を特定できる情報は保存しない。
 * 連打よけのために、IPは秘密の塩と日付を混ぜたハッシュにして、当日中の回数を数えるだけに使う。
 */
declare(strict_types=1);

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$config = require dirname(__DIR__, 2) . '/shitsurae-data/config.php';

// どこからの呼び出しを受け付けるか（ブラウザの同一生成元制限）
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, $config['allowed_origins'], true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 600');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }
// 正規の送信はすべてブラウザ経由（別ドメインからの呼び出し）で、その場合ブラウザは必ずOriginを付ける。
// Originが無いもの（curl等）は受け付けない。数字の水増しに使われる経路を塞ぐため
if ($origin === '' || !in_array($origin, $config['allowed_origins'], true)) { http_response_code(403); exit; }

// 本文は小さいはず。大きいものは読まない
$raw = file_get_contents('php://input', false, null, 0, 2048);
$in = json_decode((string)$raw, true);
if (!is_array($in)) { http_response_code(400); exit; }

// 受け付ける値を決め打ちにする（自由文字列は入れさせない）
$EVENTS = ['view', 'customize', 'variant', 'option', 'photo', 'plan', 'sample', 'trace', 'ar_open', 'share', 'save', 'order', 'error'];
$PAGES  = ['top', 'shoe', 'kintsugi', 'urushi', 'umbrella', 'ring', 'tote', 'mug', 'chair'];

$ev   = $in['ev']   ?? '';
$page = $in['page'] ?? '';
$sid  = $in['sid']  ?? '';
$extra = (string)($in['extra'] ?? '');

if (!in_array($ev, $EVENTS, true) || !in_array($page, $PAGES, true)) { http_response_code(400); exit; }
if (!preg_match('/^[a-z0-9]{8,32}$/', (string)$sid)) { http_response_code(400); exit; }
if (!preg_match('/^[A-Za-z0-9_.-]{0,40}$/', $extra)) { $extra = ''; }

// 端末の種別だけ（細かい名乗りは保存しない）
$ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
$dev = 'other';
if (preg_match('/iPhone|iPad|iPod/i', $ua)) $dev = 'ios';
elseif (preg_match('/Android/i', $ua))     $dev = 'android';
elseif (preg_match('/Windows|Macintosh|X11/i', $ua)) $dev = 'pc';

// 連打よけ用のハッシュ。復元できない形にする（塩は設定ファイルにだけある）
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
$iph = substr(hash('sha256', $ip . '|' . $config['salt'] . '|' . gmdate('Y-m-d')), 0, 16);

try {
    $db = new PDO('sqlite:' . dirname(__DIR__, 2) . '/shitsurae-data/events.sqlite');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('PRAGMA journal_mode=WAL');
    // サーバーのSQLiteは古い(3.7系)。UPSERTなどの新しい書き方は使わない
    $db->exec('CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        ev TEXT NOT NULL,
        page TEXT NOT NULL,
        sid TEXT NOT NULL,
        dev TEXT NOT NULL,
        extra TEXT NOT NULL,
        iph TEXT NOT NULL
    )');
    $db->exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)');
    $db->exec('CREATE INDEX IF NOT EXISTS idx_events_iph ON events (iph, ts)');

    // 連打よけ: 同じ送り元から1分に60件まで
    $st = $db->prepare("SELECT COUNT(*) FROM events WHERE iph = ? AND ts >= datetime('now', '-1 minute')");
    $st->execute([$iph]);
    if ((int)$st->fetchColumn() >= 60) { http_response_code(429); exit; }

    $st = $db->prepare("INSERT INTO events (ts, ev, page, sid, dev, extra, iph) VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)");
    $st->execute([$ev, $page, $sid, $dev, $extra, $iph]);
} catch (Throwable $e) {
    // 中身は返さない（設定やパスが漏れないように）
    http_response_code(500);
    exit;
}

http_response_code(204);
