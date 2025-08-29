<?php
/**
 * Simple Inventory Intake Prototype (PHP)
 * - Bulk IMEI lookup via Sickw (DHRU Fusion-compatible web API)
 * - Auto-pricing by fetching https://allenslists.pages.dev/data/prices.csv
 * - Lets operator adjust condition & price, then export a CSV
 *
 * Deployment: drop this file on any PHP server as index.php
 * Requirements: PHP 8+, allow_url_fopen enabled (for fetching external CSV)
 *
 * SECURITY NOTE: For production, move API key to an ENV var or server config.
 */

declare(strict_types=1);
ini_set('display_errors', '1');
error_reporting(E_ALL);

// ------------------- CONFIG -------------------
$SICKW_API_URL   = 'https://sickw.com/api.php';
$SICKW_API_KEY   = getenv('SICKW_API_KEY') ?: 'X5Q-O0T-R0J-15X-RG5-1E2-ZX9-2ZN'; // <-- replace via ENV in prod
$SICKW_SERVICEID = getenv('SICKW_SERVICE_ID') ?: '6'; // as requested
$SICKW_FORMAT    = 'beta'; // prefer structured JSON

$PRICES_CSV_URL  = 'https://allenslists.pages.dev/data/prices.csv';

// ------------------- HELPERS -------------------
function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }

function http_get_json(string $url, int $timeout = 30): array {
  $ctx = stream_context_create([
    'http' => ['method' => 'GET', 'timeout' => $timeout, 'header' => "Accept: application/json\r\n"]
  ]);
  $raw = @file_get_contents($url, false, $ctx);
  if ($raw === false) throw new Exception("GET failed for $url");
  $j = json_decode($raw, true);
  if (!is_array($j)) throw new Exception("Non-JSON from $url: " . substr($raw,0,200));
  return $j;
}

function fetch_sickw_one(string $imei, string $apiKey, string $serviceId, string $format, string $baseUrl): array {
  $qs = http_build_query([
    'format'  => $format,
    'key'     => $apiKey,
    'imei'    => $imei,
    'service' => $serviceId
  ]);
  $url = rtrim($baseUrl, '/') . '/api.php?' . $qs; // accept either base = https://sickw.com OR full api.php
  $data = http_get_json($url, 60);
  if (($data['status'] ?? '') !== 'success') {
    $msg = is_string($data['result'] ?? null) ? $data['result'] : json_encode($data);
    throw new Exception("Sickw error for $imei: $msg");
  }
  $r = $data['result'] ?? [];
  // Normalize fields
  $out = [
    'imei'         => $r['IMEI'] ?? ($data['imei'] ?? $imei),
    'manufacturer' => $r['Manufacturer'] ?? null,
    'model_code'   => $r['Model Code'] ?? null,
    'model_name'   => $r['Model Name'] ?? null,
  ];
  $out['device_display'] = trim(($out['manufacturer'] ? $out['manufacturer'].' ' : '') . ($out['model_name'] ?: $out['model_code'] ?: ''));
  return $out;
}

function fetch_prices_csv(string $csvUrl): array {
  $raw = @file_get_contents($csvUrl);
  if ($raw === false) throw new Exception("Failed to fetch prices CSV");
  $rows = [];
  $fp = fopen('php://temp', 'r+');
  fwrite($fp, $raw); rewind($fp);
  $header = fgetcsv($fp);
  if (!$header) throw new Exception("Empty CSV");
  // Normalize header
  $header = array_map(fn($x)=> strtolower(trim((string)$x)), $header);
  while (($r = fgetcsv($fp)) !== false) {
    $row = [];
    foreach ($header as $i => $name) {
      $row[$name] = $r[$i] ?? null;
    }
    // Expected columns: sheet,device,base_price_cents,purchase_price_cents,updated_at
    $rows[] = $row;
  }
  fclose($fp);
  return $rows;
}

// Very simple text normalize
function norm(string $s): string {
  $t = strtolower($s);
  $t = preg_replace('/[^\w\s]/u', ' ', $t);
  $t = preg_replace('/\s+/', ' ', $t);
  return trim($t);
}

// Basic similarity score using levenshtein distance (fallback to contains)
function device_price_lookup(string $deviceDisplay, array $priceRows): array {
  $needle = norm($deviceDisplay);
  $best = null;
  $bestScore = -INF;

  foreach ($priceRows as $row) {
    $dev = (string)($row['device'] ?? '');
    if ($dev === '') continue;
    $hay = norm($dev);
    $score = 0.0;

    if ($needle === '' || $hay === '') continue;
    if (str_contains($hay, $needle) || str_contains($needle, $hay)) {
      $score = 1.0; // exact-ish contains
    } else {
      // levenshtein normalized
      $len = max(strlen($needle), strlen($hay));
      $dist = levenshtein($needle, $hay);
      $score = 1.0 - min(1.0, $dist / max(1, $len));
    }

    if ($score > $bestScore) {
      $bestScore = $score;
      $best = $row;
    }
  }

  if (!$best) return ['match' => null, 'confidence' => 0.0];

  $ppc = isset($best['purchase_price_cents']) ? (int)$best['purchase_price_cents'] : null;
  $bpc = isset($best['base_price_cents']) ? (int)$best['base_price_cents'] : null;
  return [
    'match'      => $best,
    'confidence' => round($bestScore, 3),
    'purchase_price_cents' => $ppc,
    'base_price_cents'     => $bpc,
  ];
}

function post($key, $default = null) {
  return $_POST[$key] ?? $default;
}

function handle_export_csv(): void {
  $payload = json_decode($_POST['payload'] ?? '[]', true);
  if (!is_array($payload)) $payload = [];
  header('Content-Type: text/csv');
  header('Content-Disposition: attachment; filename="intake_export.csv"');
  $out = fopen('php://output', 'w');
  fputcsv($out, ['imei','manufacturer','model_name','model_code','suggested_price_cents','condition','price_paid_cents','notes']);
  foreach ($payload as $row) {
    fputcsv($out, [
      $row['imei'] ?? '',
      $row['manufacturer'] ?? '',
      $row['model_name'] ?? '',
      $row['model_code'] ?? '',
      $row['suggested_price_cents'] ?? '',
      $row['condition'] ?? '',
      $row['price_paid_cents'] ?? '',
      $row['notes'] ?? '',
    ]);
  }
  fclose($out);
  exit;
}

// ------------------- ROUTING -------------------
$action = $_GET['action'] ?? '';

if ($action === 'export') {
  handle_export_csv();
}

// ------------------- MAIN UI -------------------
$errors = [];
$results = [];
$priceRows = [];
$balance = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($action === '' || $action === 'lookup')) {
  try {
    // Optional: check balance first
    $balUrl = rtrim($SICKW_API_URL, '/') . '/api.php?action=balance&key=' . urlencode($SICKW_API_KEY);
    $balanceRaw = @file_get_contents($balUrl);
    if ($balanceRaw !== false) $balance = trim($balanceRaw);
  } catch (Exception $e) {
    // ignore
  }

  $imeisRaw = (string)($_POST['imeis'] ?? '');
  $imeis = preg_split('/[\s,;\r\n]+/', $imeisRaw, -1, PREG_SPLIT_NO_EMPTY);
  $imeis = array_slice(array_map('trim', $imeis), 0, 200); // allow up to 200 for testing

  try {
    $priceRows = fetch_prices_csv($PRICES_CSV_URL);
  } catch (Exception $e) {
    $errors[] = "Could not load prices.csv: " . $e->getMessage();
  }

  foreach ($imeis as $val) {
    try {
      $dev = fetch_sickw_one($val, $SICKW_API_KEY, $SICKW_SERVICEID, $SICKW_FORMAT, 'https://sickw.com');
      $pricing = device_price_lookup($dev['device_display'], $priceRows);
      $results[] = [
        'ok' => true,
        'imei' => $dev['imei'],
        'manufacturer' => $dev['manufacturer'],
        'model_name' => $dev['model_name'],
        'model_code' => $dev['model_code'],
        'device_display' => $dev['device_display'],
        'match_device' => $pricing['match']['device'] ?? null,
        'match_sheet'  => $pricing['match']['sheet'] ?? null,
        'base_price_cents' => $pricing['base_price_cents'] ?? null,
        'suggested_price_cents' => $pricing['purchase_price_cents'] ?? null,
        'confidence' => $pricing['confidence'] ?? 0.0,
      ];
    } catch (Exception $e) {
      $results[] = ['ok' => false, 'imei' => $val, 'error' => $e->getMessage()];
    }
    usleep(200000); // 200ms pacing
  }
}

// ------------------- HTML -------------------
?>
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inventory Intake Prototype</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0f14; color:#e6f1ff; margin:0; }
    .wrap { max-width: 1100px; margin: 20px auto; padding: 16px; background:#0f141a; border-radius:14px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
    h1 { margin-top:0; }
    textarea { width:100%; min-height: 140px; border-radius:10px; padding:10px; background:#0d1218; color:#def; border:1px solid #213244; }
    .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .btn { background:#00e29b; color:#062612; border:none; border-radius:10px; padding:10px 14px; font-weight:700; cursor:pointer; }
    .btn.secondary { background:#18344a; color:#bfeaff; }
    .muted { opacity:.7; font-size: 13px; }
    table { width:100%; border-collapse: collapse; margin-top: 16px; }
    th, td { padding: 10px 8px; border-bottom: 1px solid #213244; vertical-align: top; }
    th { text-align:left; color:#bfeaff; }
    input[type="text"], input[type="number"] { background:#0d1218; color:#def; border:1px solid #213244; border-radius:8px; padding:8px; width:100%; }
    .ok { color:#48ffb3; }
    .err { color:#ff7782; }
    .tag { display:inline-block; padding:2px 8px; border-radius:999px; background:#1b2a3a; color:#bfeaff; font-size:12px; }
    .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
    .right { text-align:right; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Inventory Intake (Prototype)</h1>
    <p class="muted">Bulk IMEI lookup with auto-pricing from <code>prices.csv</code>. Uses Sickw service <?=h($SICKW_SERVICEID)?> (format <code><?=h($SICKW_FORMAT)?></code>).</p>

    <?php if ($balance !== null): ?>
      <p class="muted">API Balance: <span class="tag"><?=h($balance)?></span></p>
    <?php endif; ?>

    <?php if ($errors): ?>
      <div class="err"><?=h(implode(" • ", $errors))?></div>
    <?php endif; ?>

    <form method="post" action="?action=lookup">
      <label><b>Enter IMEIs (one per line, comma or space separated):</b></label>
      <textarea name="imeis" placeholder="354442067957452&#10;353052118765432&#10;..."><?=h(post('imeis',''))?></textarea>
      <div class="row" style="margin-top:10px;">
        <button class="btn" type="submit">Lookup & Price</button>
        <a class="btn secondary" href="?">Reset</a>
        <span class="muted">We’ll fetch details from Sickw and suggest a price by matching the device name to the site’s CSV.</span>
      </div>
    </form>

    <?php if ($results): ?>
      <h2 style="margin-top:24px;">Results</h2>
      <form method="post" action="?action=export" id="exportForm">
        <table>
          <thead>
            <tr>
              <th>IMEI</th>
              <th>Device</th>
              <th>Matched (Sheet)</th>
              <th class="right">Base (¢)</th>
              <th class="right">Suggested (¢)</th>
              <th>Confidence</th>
              <th>Condition</th>
              <th>Price Paid (¢)</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($results as $idx => $r): ?>
              <?php if (!$r['ok']): ?>
                <tr>
                  <td colspan="9" class="err">IMEI <?=h($r['imei'])?> → <?=h($r['error'] ?? 'error')?></td>
                </tr>
              <?php else: ?>
                <tr>
                  <td><code><?=h($r['imei'])?></code></td>
                  <td><?=h($r['device_display'] ?: ($r['manufacturer'].' '.$r['model_name']))?></td>
                  <td>
                    <div><?=h((string)($r['match_device'] ?? '—'))?></div>
                    <div class="muted"><?=h((string)($r['match_sheet'] ?? ''))?></div>
                  </td>
                  <td class="right"><?=h((string)($r['base_price_cents'] ?? ''))?></td>
                  <td class="right"><b><?=h((string)($r['suggested_price_cents'] ?? ''))?></b></td>
                  <td><span class="tag"><?=h(number_format((float)$r['confidence']*100, 1))?>%</span></td>
                  <td><input type="text" name="payload[<?=$idx?>][condition]" placeholder="A/B/C" /></td>
                  <td><input type="number" name="payload[<?=$idx?>][price_paid_cents]" placeholder="<?=h((string)($r['suggested_price_cents'] ?? ''))?>" /></td>
                  <td><input type="text" name="payload[<?=$idx?>][notes]" /></td>
                </tr>
                <input type="hidden" name="payload[<?=$idx?>][imei]" value="<?=h((string)$r['imei'])?>" />
                <input type="hidden" name="payload[<?=$idx?>][manufacturer]" value="<?=h((string)$r['manufacturer'])?>" />
                <input type="hidden" name="payload[<?=$idx?>][model_name]" value="<?=h((string)$r['model_name'])?>" />
                <input type="hidden" name="payload[<?=$idx?>][model_code]" value="<?=h((string)$r['model_code'])?>" />
                <input type="hidden" name="payload[<?=$idx?>][suggested_price_cents]" value="<?=h((string)($r['suggested_price_cents'] ?? ''))?>" />
              <?php endif; ?>
            <?php endforeach; ?>
          </tbody>
        </table>
        <div class="row" style="margin-top:12px;">
          <button class="btn" type="submit">Download CSV</button>
          <span class="muted">This CSV can be imported into your purchase list table.</span>
        </div>
      </form>
    <?php endif; ?>
  </div>
</body>
</html>
