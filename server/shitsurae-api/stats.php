<?php
/*
 * しつらえの計測の集計を見る画面。
 *   GET /shitsurae-api/stats.php?key=（設定ファイルの閲覧キー）
 *   GET /shitsurae-api/stats.php?key=...&json=1   … JSONで返す
 *   GET /shitsurae-api/stats.php?key=...&days=7   … 直近7日（1〜365）
 *
 * 閲覧キーは shitsurae-data/config.php にだけある。キーが違うときは「無い」と答える。
 */
declare(strict_types=1);

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');

$config = require dirname(__DIR__, 2) . '/shitsurae-data/config.php';

$key = (string)($_GET['key'] ?? '');
// 比較は時間差で当てられない方法で行う
if ($key === '' || !hash_equals((string)$config['stats_key'], $key)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'not found';
    exit;
}

$days = (int)($_GET['days'] ?? 30);
if ($days < 1 || $days > 365) $days = 30;

$EV_LABEL = ['view' => '開いた', 'customize' => '色を変えた', 'variant' => '種類', 'option' => '仕様', 'photo' => '写真で形',
             'plan' => '真上の写真', 'sample' => '見本の写真', 'trace' => '割れをなぞった', 'ar_open' => 'ARを開いた',
             'share' => 'リンクをコピー', 'save' => '保存', 'compare' => '並べて比べた', 'order' => '注文', 'error' => 'エラー'];
$PAGE_LABEL = ['top' => 'トップ', 'shoe' => '靴', 'kintsugi' => '金継ぎ', 'urushi' => '漆', 'umbrella' => '長傘',
               'ring' => '指輪', 'tote' => 'トートバッグ', 'mug' => 'マグカップ', 'chair' => '椅子'];

$dbPath = dirname(__DIR__, 2) . '/shitsurae-data/events.sqlite';
$out = ['range_days' => $days, 'sessions' => 0, 'totals' => [], 'days' => [], 'by_page' => [], 'by_dev' => [], 'picks' => []];

if (is_file($dbPath)) {
    try {
        $db = new PDO('sqlite:' . $dbPath);
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        // $days は上で 1〜365 の整数に絞ってあるので、式に直接入れてよい
        $since = "datetime('now', '-" . $days . " days')";

        $st = $db->query("SELECT COUNT(DISTINCT sid) FROM events WHERE ts >= $since");
        $out['sessions'] = (int)$st->fetchColumn();

        foreach ($db->query("SELECT ev, COUNT(*) AS n FROM events WHERE ts >= $since GROUP BY ev") as $r) {
            $out['totals'][$r['ev']] = (int)$r['n'];
        }
        foreach ($db->query("SELECT date(ts) AS d, ev, COUNT(*) AS n FROM events WHERE ts >= $since GROUP BY date(ts), ev ORDER BY d DESC") as $r) {
            $out['days'][$r['d']][$r['ev']] = (int)$r['n'];
        }
        foreach ($db->query("SELECT page, ev, COUNT(*) AS n FROM events WHERE ts >= $since GROUP BY page, ev") as $r) {
            $out['by_page'][$r['page']][$r['ev']] = (int)$r['n'];
        }
        foreach ($db->query("SELECT dev, COUNT(DISTINCT sid) AS n FROM events WHERE ts >= $since GROUP BY dev") as $r) {
            $out['by_dev'][$r['dev']] = (int)$r['n'];
        }
        // 選ばれた種類・仕様（よく選ばれたもの上位30）
        foreach ($db->query("SELECT page, ev, extra, COUNT(*) AS n FROM events WHERE ts >= $since AND ev IN ('variant','option') AND extra <> '' GROUP BY page, ev, extra ORDER BY n DESC LIMIT 30") as $r) {
            $out['picks'][] = ['page' => $r['page'], 'ev' => $r['ev'], 'extra' => $r['extra'], 'n' => (int)$r['n']];
        }
    } catch (Throwable $e) {
        http_response_code(500);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'error';
        exit;
    }
}

if (isset($_GET['json'])) {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($out, JSON_UNESCAPED_UNICODE);
    exit;
}

header('Content-Type: text/html; charset=utf-8');
$h = fn($v) => htmlspecialchars((string)$v, ENT_QUOTES, 'UTF-8');
$t = $out['totals'];
$COLS = ['view', 'customize', 'ar_open', 'share', 'save', 'compare', 'order'];
?>
<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>しつらえ 計測</title>
<style>
  body{margin:0;padding:22px 16px 40px;font-family:system-ui,"Hiragino Kaku Gothic ProN",sans-serif;line-height:1.7;background:#eef0ec;color:#1c2321}
  .wrap{max-width:860px;margin:0 auto}
  h1{font-size:19px;margin:0 0 4px} .sub{font-size:13px;opacity:.75;margin:0 0 18px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:22px}
  .tile{background:#fff;border:1px solid #c5ccc6;border-radius:10px;padding:12px 14px}
  .tile b{display:block;font-size:24px} .tile span{font-size:12.5px;opacity:.75}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}
  th,td{border:1px solid #c5ccc6;padding:6px 8px;text-align:right;white-space:nowrap} th:first-child,td:first-child{text-align:left}
  h2{font-size:15px;margin:22px 0 8px}
  .days a{margin-right:10px}
</style></head><body><div class="wrap">
<h1>しつらえ 計測</h1>
<p class="sub">直近 <?= $h($days) ?> 日 ／ 集計時刻 <?= $h(gmdate('Y-m-d H:i')) ?> UTC ／ 記録するのは操作の回数だけで、個人を特定する情報は保存していません</p>
<p class="days sub">期間：<?php foreach ([7, 30, 90] as $d) echo '<a href="?key=' . $h($key) . '&days=' . $d . '">' . $d . '日</a>'; ?></p>

<div class="tiles">
  <div class="tile"><b><?= $h($out['sessions']) ?></b><span>訪問（端末×回）</span></div>
  <div class="tile"><b><?= $h($t['view'] ?? 0) ?></b><span>ページを開いた</span></div>
  <div class="tile"><b><?= $h($t['customize'] ?? 0) ?></b><span>色や素材を変えた訪問</span></div>
  <div class="tile"><b><?= $h($t['ar_open'] ?? 0) ?></b><span>ARを開いた</span></div>
  <div class="tile"><b><?= $h(($t['share'] ?? 0) + ($t['save'] ?? 0)) ?></b><span>リンクのコピー・保存</span></div>
  <div class="tile"><b><?= $h($t['order'] ?? 0) ?></b><span>注文（デモ）</span></div>
</div>

<h2>商品ごと</h2>
<div class="scroll"><table><tr><th>ページ</th><?php foreach ($COLS as $c) echo '<th>' . $h($EV_LABEL[$c]) . '</th>'; ?><th>写真・なぞり</th></tr>
<?php foreach ($PAGE_LABEL as $p => $label): $r = $out['by_page'][$p] ?? []; ?>
<tr><td><?= $h($label) ?></td><?php foreach ($COLS as $c) echo '<td>' . $h($r[$c] ?? 0) . '</td>'; ?><td><?= $h(($r['photo'] ?? 0) + ($r['plan'] ?? 0) + ($r['sample'] ?? 0) + ($r['trace'] ?? 0)) ?></td></tr>
<?php endforeach; ?>
</table></div>

<h2>日別</h2>
<div class="scroll"><table><tr><th>日付</th><?php foreach ($COLS as $c) echo '<th>' . $h($EV_LABEL[$c]) . '</th>'; ?></tr>
<?php foreach ($out['days'] as $d => $evs): ?>
<tr><td><?= $h($d) ?></td><?php foreach ($COLS as $c) echo '<td>' . $h($evs[$c] ?? 0) . '</td>'; ?></tr>
<?php endforeach; if (!$out['days']): ?><tr><td colspan="8" style="text-align:center">まだ記録がありません</td></tr><?php endif; ?>
</table></div>

<h2>端末の種類（訪問数）</h2>
<table><tr><th>種類</th><th>訪問</th></tr>
<?php foreach ($out['by_dev'] as $k => $n) echo '<tr><td>' . $h(['ios' => 'iPhone・iPad', 'android' => 'Android', 'pc' => 'PC', 'other' => 'その他'][$k] ?? $k) . '</td><td>' . $h($n) . '</td></tr>'; ?>
</table>

<h2>よく選ばれた種類・仕様</h2>
<table><tr><th>ページ</th><th>選んだもの</th><th>回数</th></tr>
<?php foreach ($out['picks'] as $r) echo '<tr><td>' . $h($PAGE_LABEL[$r['page']] ?? $r['page']) . '</td><td>' . $h($r['extra']) . '</td><td>' . $h($r['n']) . '</td></tr>'; ?>
<?php if (!$out['picks']): ?><tr><td colspan="3" style="text-align:center">まだ記録がありません</td></tr><?php endif; ?>
</table>
</div></body></html>
