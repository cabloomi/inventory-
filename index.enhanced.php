<?php
/**
 * Enhanced Inventory Management System
 * 
 * Features:
 * - Bulk IMEI lookup via Sickw API
 * - Auto-pricing from CSV
 * - Direct inventory import
 * - Cash drawer management
 * - Warehouse transfer functionality
 * - Eastern Time timestamps
 * - Improved UI
 */

declare(strict_types=1);
ini_set('display_errors', '1');
error_reporting(E_ALL);

// Include database utilities
require_once __DIR__ . '/database/db.php';

// ------------------- CONFIG -------------------
$SICKW_API_URL   = 'https://sickw.com/api.php';
$SICKW_API_KEY   = getenv('SICKW_API_KEY') ?: 'X5Q-O0T-R0J-15X-RG5-1E2-ZX9-2ZN'; // <-- replace via ENV in prod
$SICKW_SERVICEID = getenv('SICKW_SERVICE_ID') ?: '6'; // as requested
$SICKW_FORMAT    = 'beta'; // prefer structured JSON

$PRICES_CSV_URL  = 'https://allenslists.pages.dev/data/prices.csv';

// Default user ID (in a real app, this would come from authentication)
$CURRENT_USER_ID = 1;

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

function formatMoney($cents) {
  return '$' . number_format($cents / 100, 2);
}

// ------------------- ROUTING -------------------
$action = $_GET['action'] ?? '';

// Handle API balance check
if ($action === 'check_balance') {
  try {
    $balUrl = rtrim($SICKW_API_URL, '/') . '/api.php?action=balance&key=' . urlencode($SICKW_API_KEY);
    $balanceRaw = @file_get_contents($balUrl);
    if ($balanceRaw !== false) {
      echo json_encode(['success' => true, 'balance' => trim($balanceRaw)]);
    } else {
      echo json_encode(['success' => false, 'error' => 'Failed to fetch balance']);
    }
  } catch (Exception $e) {
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
  }
  exit;
}

// Handle inventory import
if ($action === 'import_inventory') {
  $payload = json_decode($_POST['payload'] ?? '[]', true);
  if (!is_array($payload)) $payload = [];
  
  $results = [];
  foreach ($payload as $item) {
    // Add to database
    $inventoryItem = [
      'imei' => $item['imei'] ?? '',
      'manufacturer' => $item['manufacturer'] ?? '',
      'model_name' => $item['model_name'] ?? '',
      'model_code' => $item['model_code'] ?? '',
      'device_display' => $item['device_display'] ?? '',
      'color' => $item['color'] ?? '',
      'storage' => $item['storage'] ?? '',
      'carrier' => $item['carrier'] ?? '',
      'condition' => $item['condition'] ?? '',
      'icloud_lock_on' => $item['icloud_lock_on'] ?? false,
      'price_paid_cents' => $item['price_paid_cents'] ?? 0,
      'suggested_price_cents' => $item['suggested_price_cents'] ?? 0,
      'notes' => $item['notes'] ?? '',
      'created_by' => $CURRENT_USER_ID
    ];
    
    $id = Database::addInventoryItem($inventoryItem);
    if ($id) {
      $results[] = [
        'success' => true,
        'id' => $id,
        'imei' => $item['imei']
      ];
      
      // Log audit
      Database::logAudit(
        $CURRENT_USER_ID,
        'import',
        'inventory_item',
        $id,
        "Imported item: {$item['device_display']}"
      );
    } else {
      $results[] = [
        'success' => false,
        'imei' => $item['imei'],
        'error' => 'Failed to add to inventory'
      ];
    }
  }
  
  header('Content-Type: application/json');
  echo json_encode(['results' => $results]);
  exit;
}

// Handle cash drawer operations
if ($action === 'open_cash_drawer') {
  $amount = (int)($_POST['amount'] ?? 0);
  $notes = $_POST['notes'] ?? '';
  
  $result = Database::openCashDrawer($amount, $CURRENT_USER_ID, $notes);
  
  if ($result) {
    Database::logAudit(
      $CURRENT_USER_ID,
      'open',
      'cash_drawer',
      $result,
      "Opened cash drawer with $" . ($amount / 100)
    );
    
    header('Location: ?tab=cash_drawer&msg=opened');
  } else {
    header('Location: ?tab=cash_drawer&error=failed_to_open');
  }
  exit;
}

if ($action === 'close_cash_drawer') {
  $amount = (int)($_POST['amount'] ?? 0);
  $notes = $_POST['notes'] ?? '';
  
  $result = Database::closeCashDrawer($amount, $CURRENT_USER_ID, $notes);
  
  if ($result) {
    Database::logAudit(
      $CURRENT_USER_ID,
      'close',
      'cash_drawer',
      0,
      "Closed cash drawer with $" . ($amount / 100)
    );
    
    header('Location: ?tab=cash_drawer&msg=closed');
  } else {
    header('Location: ?tab=cash_drawer&error=failed_to_close');
  }
  exit;
}

if ($action === 'add_transaction') {
  $amount = (int)($_POST['amount'] ?? 0);
  $type = $_POST['type'] ?? '';
  $notes = $_POST['notes'] ?? '';
  
  $result = Database::recordCashTransaction($amount, $type, null, $CURRENT_USER_ID, $notes);
  
  if ($result) {
    Database::logAudit(
      $CURRENT_USER_ID,
      'add',
      'cash_transaction',
      $result,
      "$type transaction: $" . ($amount / 100)
    );
    
    header('Location: ?tab=cash_drawer&msg=transaction_added');
  } else {
    header('Location: ?tab=cash_drawer&error=failed_to_add_transaction');
  }
  exit;
}

// Handle warehouse transfer
if ($action === 'transfer_to_warehouse') {
  $itemIds = $_POST['item_ids'] ?? [];
  $notes = $_POST['notes'] ?? '';
  
  if (!empty($itemIds)) {
    $result = Database::createWarehouseTransfer($itemIds, $CURRENT_USER_ID, $notes);
    
    if ($result) {
      Database::logAudit(
        $CURRENT_USER_ID,
        'transfer',
        'warehouse_transfer',
        $result,
        "Transferred " . count($itemIds) . " items to warehouse"
      );
      
      header('Location: ?tab=inventory&msg=transferred');
    } else {
      header('Location: ?tab=inventory&error=failed_to_transfer');
    }
  } else {
    header('Location: ?tab=inventory&error=no_items_selected');
  }
  exit;
}

// ------------------- MAIN UI -------------------
$errors = [];
$results = [];
$priceRows = [];
$balance = null;
$activeTab = $_GET['tab'] ?? 'lookup';
$cashDrawer = null;
$inventoryItems = [];

// Get active cash drawer if on cash drawer tab
if ($activeTab === 'cash_drawer') {
  $cashDrawer = Database::getActiveCashDrawer();
}

// Get inventory items if on inventory tab
if ($activeTab === 'inventory') {
  $filters = [
    'status' => $_GET['status'] ?? 'in_stock',
    'location' => $_GET['location'] ?? 'store',
    'search' => $_GET['search'] ?? ''
  ];
  
  $page = max(1, (int)($_GET['page'] ?? 1));
  $limit = 50;
  $offset = ($page - 1) * $limit;
  
  $inventoryItems = Database::getInventoryItems($filters, $limit, $offset);
}

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
  <title>Enhanced Inventory Management</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <style>
    :root {
      --primary: #00e29b;
      --primary-dark: #00b37a;
      --secondary: #18344a;
      --secondary-light: #1f4060;
      --background: #0b0f14;
      --card-bg: #0f141a;
      --input-bg: #0d1218;
      --border: #213244;
      --text: #e6f1ff;
      --text-muted: #a0b8d0;
      --success: #48ffb3;
      --error: #ff7782;
      --warning: #ffbe0b;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body { 
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; 
      background: var(--background); 
      color: var(--text); 
      margin: 0;
      line-height: 1.5;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    
    .header h1 {
      font-size: 24px;
      font-weight: 700;
    }
    
    .header-right {
      display: flex;
      align-items: center;
      gap: 15px;
    }
    
    .balance-display {
      background: var(--secondary);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .balance-display i {
      color: var(--primary);
    }
    
    .tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 20px;
      background: var(--secondary);
      border-radius: 10px;
      padding: 5px;
    }
    
    .tab {
      padding: 12px 20px;
      cursor: pointer;
      border-radius: 8px;
      font-weight: 600;
      text-align: center;
      flex: 1;
      transition: all 0.2s ease;
      color: var(--text-muted);
    }
    
    .tab.active {
      background: var(--card-bg);
      color: var(--text);
    }
    
    .tab:hover:not(.active) {
      background: var(--secondary-light);
      color: var(--text);
    }
    
    .tab i {
      margin-right: 8px;
    }
    
    .card {
      background: var(--card-bg);
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,.25);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    
    .card-header h2 {
      font-size: 18px;
      font-weight: 600;
    }
    
    textarea, input[type="text"], input[type="number"], input[type="password"], select {
      width: 100%;
      padding: 12px;
      background: var(--input-bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 14px;
    }
    
    textarea {
      min-height: 140px;
      resize: vertical;
    }
    
    .form-group {
      margin-bottom: 15px;
    }
    
    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
    }
    
    .btn {
      background: var(--primary);
      color: #062612;
      border: none;
      border-radius: 8px;
      padding: 12px 20px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    
    .btn:hover {
      background: var(--primary-dark);
    }
    
    .btn.secondary {
      background: var(--secondary);
      color: var(--text);
    }
    
    .btn.secondary:hover {
      background: var(--secondary-light);
    }
    
    .btn.danger {
      background: var(--error);
      color: #fff;
    }
    
    .btn.sm {
      padding: 6px 12px;
      font-size: 13px;
    }
    
    .row {
      display: flex;
      gap: 15px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    
    .col {
      flex: 1;
      min-width: 200px;
    }
    
    .muted {
      color: var(--text-muted);
      font-size: 14px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    
    th, td {
      padding: 12px 10px;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    
    th {
      color: var(--text-muted);
      font-weight: 600;
      font-size: 13px;
      text-transform: uppercase;
    }
    
    tbody tr:hover {
      background: rgba(255,255,255,0.03);
    }
    
    .tag {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--secondary);
      color: var(--text);
      font-size: 12px;
      font-weight: 500;
    }
    
    .tag.success {
      background: rgba(72, 255, 179, 0.15);
      color: var(--success);
    }
    
    .tag.error {
      background: rgba(255, 119, 130, 0.15);
      color: var(--error);
    }
    
    .tag.warning {
      background: rgba(255, 190, 11, 0.15);
      color: var(--warning);
    }
    
    .alert {
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .alert.success {
      background: rgba(72, 255, 179, 0.1);
      border: 1px solid rgba(72, 255, 179, 0.2);
      color: var(--success);
    }
    
    .alert.error {
      background: rgba(255, 119, 130, 0.1);
      border: 1px solid rgba(255, 119, 130, 0.2);
      color: var(--error);
    }
    
    .alert.warning {
      background: rgba(255, 190, 11, 0.1);
      border: 1px solid rgba(255, 190, 11, 0.2);
      color: var(--warning);
    }
    
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .checkbox-group input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--primary);
    }
    
    .pagination {
      display: flex;
      justify-content: center;
      gap: 5px;
      margin-top: 20px;
    }
    
    .pagination a {
      padding: 8px 12px;
      background: var(--secondary);
      color: var(--text);
      border-radius: 6px;
      text-decoration: none;
    }
    
    .pagination a.active {
      background: var(--primary);
      color: #062612;
    }
    
    .search-bar {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    
    .search-bar input {
      flex: 1;
    }
    
    .filters {
      display: flex;
      gap: 15px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    
    .filter-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .filter-item label {
      font-size: 14px;
      color: var(--text-muted);
    }
    
    .filter-item select {
      width: auto;
      padding: 8px 12px;
    }
    
    .cash-drawer-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    
    .cash-stat {
      background: var(--secondary);
      padding: 15px;
      border-radius: 10px;
      text-align: center;
    }
    
    .cash-stat-value {
      font-size: 24px;
      font-weight: 700;
      margin-top: 5px;
    }
    
    .cash-stat-label {
      font-size: 13px;
      color: var(--text-muted);
    }
    
    .transaction-list {
      max-height: 400px;
      overflow-y: auto;
    }
    
    .transaction-item {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    
    .transaction-info {
      display: flex;
      flex-direction: column;
    }
    
    .transaction-amount {
      font-weight: 600;
      font-size: 16px;
    }
    
    .transaction-amount.positive {
      color: var(--success);
    }
    
    .transaction-amount.negative {
      color: var(--error);
    }
    
    .transaction-meta {
      font-size: 13px;
      color: var(--text-muted);
    }
    
    .loader {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.7);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    
    .loader.show {
      display: flex;
    }
    
    .spinner {
      width: 50px;
      height: 50px;
      border: 5px solid rgba(255,255,255,0.1);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .modal {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.7);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    
    .modal.show {
      display: flex;
    }
    
    .modal-content {
      background: var(--card-bg);
      border-radius: 14px;
      padding: 20px;
      width: 100%;
      max-width: 500px;
      box-shadow: 0 10px 30px rgba(0,0,0,.3);
    }
    
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--border);
    }
    
    .modal-header h3 {
      font-size: 18px;
      font-weight: 600;
    }
    
    .modal-close {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 20px;
    }
    
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 20px;
      padding-top: 15px;
      border-top: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Enhanced Inventory Management</h1>
      <div class="header-right">
        <div class="balance-display">
          <i class="fas fa-wallet"></i>
          <span id="balance-display">API Balance: <span class="tag" id="balance-value">Loading...</span></span>
        </div>
        <button class="btn secondary" id="refresh-balance">
          <i class="fas fa-sync-alt"></i>
        </button>
      </div>
    </div>
    
    <div class="tabs">
      <a href="?tab=lookup" class="tab <?= $activeTab === 'lookup' ? 'active' : '' ?>">
        <i class="fas fa-search"></i> Lookup
      </a>
      <a href="?tab=inventory" class="tab <?= $activeTab === 'inventory' ? 'active' : '' ?>">
        <i class="fas fa-boxes"></i> Inventory
      </a>
      <a href="?tab=cash_drawer" class="tab <?= $activeTab === 'cash_drawer' ? 'active' : '' ?>">
        <i class="fas fa-cash-register"></i> Cash Drawer
      </a>
      <a href="?tab=warehouse" class="tab <?= $activeTab === 'warehouse' ? 'active' : '' ?>">
        <i class="fas fa-warehouse"></i> Warehouse
      </a>
    </div>
    
    <?php if (isset($_GET['msg'])): ?>
      <div class="alert success">
        <i class="fas fa-check-circle"></i>
        <?php if ($_GET['msg'] === 'imported'): ?>
          Items successfully imported to inventory.
        <?php elseif ($_GET['msg'] === 'transferred'): ?>
          Items successfully transferred to warehouse.
        <?php elseif ($_GET['msg'] === 'opened'): ?>
          Cash drawer successfully opened.
        <?php elseif ($_GET['msg'] === 'closed'): ?>
          Cash drawer successfully closed.
        <?php elseif ($_GET['msg'] === 'transaction_added'): ?>
          Transaction successfully recorded.
        <?php else: ?>
          Operation completed successfully.
        <?php endif; ?>
      </div>
    <?php endif; ?>
    
    <?php if (isset($_GET['error'])): ?>
      <div class="alert error">
        <i class="fas fa-exclamation-circle"></i>
        <?php if ($_GET['error'] === 'failed_to_import'): ?>
          Failed to import items to inventory.
        <?php elseif ($_GET['error'] === 'failed_to_transfer'): ?>
          Failed to transfer items to warehouse.
        <?php elseif ($_GET['error'] === 'no_items_selected'): ?>
          No items selected for transfer.
        <?php elseif ($_GET['error'] === 'failed_to_open'): ?>
          Failed to open cash drawer. There may already be an open drawer.
        <?php elseif ($_GET['error'] === 'failed_to_close'): ?>
          Failed to close cash drawer.
        <?php elseif ($_GET['error'] === 'failed_to_add_transaction'): ?>
          Failed to record transaction. Make sure a cash drawer is open.
        <?php else: ?>
          An error occurred during the operation.
        <?php endif; ?>
      </div>
    <?php endif; ?>
    
    <?php if ($activeTab === 'lookup'): ?>
      <!-- IMEI Lookup Tab -->
      <div class="card">
        <div class="card-header">
          <h2>Bulk IMEI Lookup</h2>
        </div>
        
        <?php if ($errors): ?>
          <div class="alert error">
            <i class="fas fa-exclamation-circle"></i>
            <?= h(implode(" • ", $errors)) ?>
          </div>
        <?php endif; ?>
        
        <form method="post" action="?action=lookup">
          <div class="form-group">
            <label><b>Enter IMEIs (one per line, comma or space separated):</b></label>
            <textarea name="imeis" placeholder="354442067957452&#10;353052118765432&#10;..."><?= h(post('imeis','')) ?></textarea>
          </div>
          
          <div class="row">
            <button class="btn" type="submit">
              <i class="fas fa-search"></i> Lookup & Price
            </button>
            <a class="btn secondary" href="?tab=lookup">
              <i class="fas fa-redo"></i> Reset
            </a>
            <p class="muted">We'll fetch details from Sickw and suggest a price by matching the device name to the site's CSV.</p>
          </div>
        </form>
      </div>
      
      <?php if ($results): ?>
        <div class="card">
          <div class="card-header">
            <h2>Results</h2>
            <button class="btn" id="import-to-inventory">
              <i class="fas fa-file-import"></i> Import to Inventory
            </button>
          </div>
          
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th style="width: 30px;">
                    <input type="checkbox" id="select-all">
                  </th>
                  <th>IMEI</th>
                  <th>Device</th>
                  <th>Base (¢)</th>
                  <th>Suggested (¢)</th>
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
                      <td></td>
                      <td colspan="8" class="error">
                        <i class="fas fa-exclamation-circle"></i>
                        IMEI <?= h($r['imei']) ?> → <?= h($r['error'] ?? 'error') ?>
                      </td>
                    </tr>
                  <?php else: ?>
                    <tr class="result-row" data-idx="<?= $idx ?>">
                      <td>
                        <input type="checkbox" class="select-item" data-idx="<?= $idx ?>">
                      </td>
                      <td><code><?= h($r['imei']) ?></code></td>
                      <td><?= h($r['device_display'] ?: ($r['manufacturer'].' '.$r['model_name'])) ?></td>
                      <td class="right"><?= h((string)($r['base_price_cents'] ?? '')) ?></td>
                      <td class="right"><b><?= h((string)($r['suggested_price_cents'] ?? '')) ?></b></td>
                      <td>
                        <?php
                          $confidence = (float)$r['confidence'] * 100;
                          $confidenceClass = $confidence > 80 ? 'success' : ($confidence > 50 ? 'warning' : 'error');
                        ?>
                        <span class="tag <?= $confidenceClass ?>"><?= h(number_format($confidence, 1)) ?>%</span>
                      </td>
                      <td>
                        <select class="condition-select" data-idx="<?= $idx ?>">
                          <option value="A">A - Like New</option>
                          <option value="B" selected>B - Good</option>
                          <option value="C">C - Fair</option>
                          <option value="D">D - Poor</option>
                        </select>
                      </td>
                      <td>
                        <input type="number" class="price-paid" data-idx="<?= $idx ?>" placeholder="<?= h((string)($r['suggested_price_cents'] ?? '')) ?>" value="<?= h((string)($r['suggested_price_cents'] ?? '')) ?>">
                      </td>
                      <td>
                        <input type="text" class="notes" data-idx="<?= $idx ?>" placeholder="Optional notes">
                      </td>
                    </tr>
                    <input type="hidden" class="imei" data-idx="<?= $idx ?>" value="<?= h((string)$r['imei']) ?>">
                    <input type="hidden" class="manufacturer" data-idx="<?= $idx ?>" value="<?= h((string)$r['manufacturer']) ?>">
                    <input type="hidden" class="model-name" data-idx="<?= $idx ?>" value="<?= h((string)$r['model_name']) ?>">
                    <input type="hidden" class="model-code" data-idx="<?= $idx ?>" value="<?= h((string)$r['model_code']) ?>">
                    <input type="hidden" class="device-display" data-idx="<?= $idx ?>" value="<?= h((string)$r['device_display']) ?>">
                    <input type="hidden" class="suggested-price" data-idx="<?= $idx ?>" value="<?= h((string)($r['suggested_price_cents'] ?? '')) ?>">
                  <?php endif; ?>
                <?php endforeach; ?>
              </tbody>
            </table>
          </div>
        </div>
      <?php endif; ?>
    <?php endif; ?>
    
    <?php if ($activeTab === 'inventory'): ?>
      <!-- Inventory Tab -->
      <div class="card">
        <div class="card-header">
          <h2>Inventory Management</h2>
          <button class="btn" id="transfer-to-warehouse-btn">
            <i class="fas fa-truck-loading"></i> Transfer to Warehouse
          </button>
        </div>
        
        <div class="search-bar">
          <form action="?tab=inventory" method="get" style="display: flex; gap: 10px; width: 100%;">
            <input type="hidden" name="tab" value="inventory">
            <input type="text" name="search" placeholder="Search by IMEI, device name..." value="<?= h($_GET['search'] ?? '') ?>">
            <button type="submit" class="btn">
              <i class="fas fa-search"></i> Search
            </button>
          </form>
        </div>
        
        <div class="filters">
          <div class="filter-item">
            <label>Status:</label>
            <select name="status" id="status-filter" onchange="updateFilters()">
              <option value="in_stock" <?= ($_GET['status'] ?? 'in_stock') === 'in_stock' ? 'selected' : '' ?>>In Stock</option>
              <option value="sold" <?= ($_GET['status'] ?? '') === 'sold' ? 'selected' : '' ?>>Sold</option>
              <option value="transferred_to_warehouse" <?= ($_GET['status'] ?? '') === 'transferred_to_warehouse' ? 'selected' : '' ?>>Transferred to Warehouse</option>
              <option value="all" <?= ($_GET['status'] ?? '') === 'all' ? 'selected' : '' ?>>All</option>
            </select>
          </div>
          
          <div class="filter-item">
            <label>Location:</label>
            <select name="location" id="location-filter" onchange="updateFilters()">
              <option value="store" <?= ($_GET['location'] ?? 'store') === 'store' ? 'selected' : '' ?>>Store</option>
              <option value="warehouse" <?= ($_GET['location'] ?? '') === 'warehouse' ? 'selected' : '' ?>>Warehouse</option>
              <option value="all" <?= ($_GET['location'] ?? '') === 'all' ? 'selected' : '' ?>>All</option>
            </select>
          </div>
        </div>
        
        <div class="table-responsive">
          <form id="transfer-form" action="?action=transfer_to_warehouse" method="post">
            <table>
              <thead>
                <tr>
                  <th style="width: 30px;">
                    <input type="checkbox" id="select-all-inventory">
                  </th>
                  <th>IMEI</th>
                  <th>Device</th>
                  <th>Condition</th>
                  <th>Price Paid</th>
                  <th>Status</th>
                  <th>Added</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <?php if (empty($inventoryItems)): ?>
                  <tr>
                    <td colspan="8" style="text-align: center; padding: 30px;">
                      <i class="fas fa-box-open" style="font-size: 24px; margin-bottom: 10px; display: block; opacity: 0.5;"></i>
                      No inventory items found.
                    </td>
                  </tr>
                <?php else: ?>
                  <?php foreach ($inventoryItems as $item): ?>
                    <tr>
                      <td>
                        <input type="checkbox" name="item_ids[]" value="<?= $item['id'] ?>" class="inventory-select-item" <?= $item['status'] !== 'in_stock' ? 'disabled' : '' ?>>
                      </td>
                      <td><code><?= h($item['imei']) ?></code></td>
                      <td><?= h($item['device_display']) ?></td>
                      <td><?= h($item['condition']) ?></td>
                      <td><?= formatMoney($item['price_paid_cents']) ?></td>
                      <td>
                        <?php if ($item['status'] === 'in_stock'): ?>
                          <span class="tag success">In Stock</span>
                        <?php elseif ($item['status'] === 'sold'): ?>
                          <span class="tag">Sold</span>
                        <?php elseif ($item['status'] === 'transferred_to_warehouse'): ?>
                          <span class="tag warning">Transferred</span>
                        <?php endif; ?>
                      </td>
                      <td><?= Database::formatTimestamp(Database::convertToEasternTime($item['created_at'])) ?></td>
                      <td>
                        <button type="button" class="btn secondary sm view-item" data-id="<?= $item['id'] ?>">
                          <i class="fas fa-eye"></i>
                        </button>
                      </td>
                    </tr>
                  <?php endforeach; ?>
                <?php endif; ?>
              </tbody>
            </table>
            
            <input type="hidden" name="notes" id="transfer-notes" value="">
          </form>
        </div>
        
        <!-- Pagination -->
        <div class="pagination">
          <?php
            $page = max(1, (int)($_GET['page'] ?? 1));
            $prevPage = max(1, $page - 1);
            $nextPage = $page + 1;
            
            $queryParams = $_GET;
            $queryParams['tab'] = 'inventory';
          ?>
          
          <?php
            $prevParams = $queryParams;
            $prevParams['page'] = $prevPage;
            $prevQuery = http_build_query($prevParams);
            
            $nextParams = $queryParams;
            $nextParams['page'] = $nextPage;
            $nextQuery = http_build_query($nextParams);
          ?>
          
          <a href="?<?= $prevQuery ?>" <?= $page === 1 ? 'style="opacity: 0.5; pointer-events: none;"' : '' ?>>
            <i class="fas fa-chevron-left"></i> Previous
          </a>
          
          <a href="#" class="active"><?= $page ?></a>
          
          <a href="?<?= $nextQuery ?>" <?= empty($inventoryItems) || count($inventoryItems) < 50 ? 'style="opacity: 0.5; pointer-events: none;"' : '' ?>>
            Next <i class="fas fa-chevron-right"></i>
          </a>
        </div>
      </div>
    <?php endif; ?>
    
    <?php if ($activeTab === 'cash_drawer'): ?>
      <!-- Cash Drawer Tab -->
      <div class="card">
        <div class="card-header">
          <h2>Cash Drawer Management</h2>
          <?php if ($cashDrawer): ?>
            <button class="btn danger" id="close-drawer-btn">
              <i class="fas fa-cash-register"></i> Close Drawer
            </button>
          <?php else: ?>
            <button class="btn" id="open-drawer-btn">
              <i class="fas fa-cash-register"></i> Open Drawer
            </button>
          <?php endif; ?>
        </div>
        
        <?php if ($cashDrawer): ?>
          <!-- Active Cash Drawer -->
          <div class="cash-drawer-summary">
            <div class="cash-stat">
              <div class="cash-stat-label">Opening Amount</div>
              <div class="cash-stat-value"><?= formatMoney($cashDrawer['opening_amount_cents']) ?></div>
            </div>
            
            <div class="cash-stat">
              <div class="cash-stat-label">Current Balance</div>
              <div class="cash-stat-value"><?= formatMoney($cashDrawer['expected_amount_cents']) ?></div>
            </div>
            
            <div class="cash-stat">
              <div class="cash-stat-label">Opened At</div>
              <div class="cash-stat-value" style="font-size: 16px;">
                <?= Database::formatTimestamp(Database::convertToEasternTime($cashDrawer['opened_at'])) ?>
              </div>
            </div>
          </div>
          
          <div class="row">
            <div class="col">
              <div class="card-header">
                <h3>Recent Transactions</h3>
                <button class="btn" id="add-transaction-btn">
                  <i class="fas fa-plus"></i> Add Transaction
                </button>
              </div>
              
              <div class="transaction-list">
                <?php if (empty($cashDrawer['transactions'])): ?>
                  <div style="text-align: center; padding: 30px;">
                    <i class="fas fa-receipt" style="font-size: 24px; margin-bottom: 10px; display: block; opacity: 0.5;"></i>
                    No transactions yet.
                  </div>
                <?php else: ?>
                  <?php foreach ($cashDrawer['transactions'] as $transaction): ?>
                    <div class="transaction-item">
                      <div class="transaction-info">
                        <div class="transaction-type">
                          <?php if ($transaction['transaction_type'] === 'purchase'): ?>
                            <i class="fas fa-shopping-cart"></i> Purchase
                          <?php elseif ($transaction['transaction_type'] === 'sale'): ?>
                            <i class="fas fa-tag"></i> Sale
                          <?php elseif ($transaction['transaction_type'] === 'adjustment'): ?>
                            <i class="fas fa-sliders-h"></i> Adjustment
                          <?php else: ?>
                            <i class="fas fa-exchange-alt"></i> <?= h(ucfirst($transaction['transaction_type'])) ?>
                          <?php endif; ?>
                        </div>
                        <div class="transaction-meta">
                          <?= Database::formatTimestamp(Database::convertToEasternTime($transaction['created_at'])) ?>
                          <?php if ($transaction['notes']): ?>
                            • <?= h($transaction['notes']) ?>
                          <?php endif; ?>
                        </div>
                      </div>
                      <div class="transaction-amount <?= $transaction['amount_cents'] >= 0 ? 'positive' : 'negative' ?>">
                        <?= $transaction['amount_cents'] >= 0 ? '+' : '' ?><?= formatMoney($transaction['amount_cents']) ?>
                      </div>
                    </div>
                  <?php endforeach; ?>
                <?php endif; ?>
              </div>
            </div>
          </div>
        <?php else: ?>
          <!-- No Active Cash Drawer -->
          <div style="text-align: center; padding: 50px 20px;">
            <i class="fas fa-cash-register" style="font-size: 48px; margin-bottom: 20px; display: block; opacity: 0.5;"></i>
            <h3 style="margin-bottom: 10px;">No Active Cash Drawer</h3>
            <p class="muted">Open a cash drawer to start recording transactions.</p>
            <button class="btn" id="open-drawer-btn-center" style="margin-top: 20px;">
              <i class="fas fa-cash-register"></i> Open Cash Drawer
            </button>
          </div>
        <?php endif; ?>
      </div>
    <?php endif; ?>
    
    <?php if ($activeTab === 'warehouse'): ?>
      <!-- Warehouse Tab -->
      <div class="card">
        <div class="card-header">
          <h2>Warehouse Management</h2>
        </div>
        
        <div style="text-align: center; padding: 50px 20px;">
          <i class="fas fa-warehouse" style="font-size: 48px; margin-bottom: 20px; display: block; opacity: 0.5;"></i>
          <h3 style="margin-bottom: 10px;">Warehouse Portal</h3>
          <p class="muted">The warehouse portal is currently under development.</p>
          <p class="muted">Coming soon: Inventory management, receiving transfers, and more.</p>
        </div>
      </div>
    <?php endif; ?>
  </div>
  
  <!-- Loader -->
  <div class="loader" id="loader">
    <div class="spinner"></div>
  </div>
  
  <!-- Modals -->
  <!-- Import to Inventory Modal -->
  <div class="modal" id="import-modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Import to Inventory</h3>
        <button class="modal-close" id="import-modal-close">&times;</button>
      </div>
      
      <p>Are you sure you want to import the selected items to inventory?</p>
      
      <div class="form-group">
        <label>Additional Notes (Optional):</label>
        <textarea id="import-notes" placeholder="Enter any additional notes..."></textarea>
      </div>
      
      <div class="modal-footer">
        <button class="btn secondary" id="import-modal-cancel">Cancel</button>
        <button class="btn" id="import-confirm">Import Items</button>
      </div>
    </div>
  </div>
  
  <!-- Transfer to Warehouse Modal -->
  <div class="modal" id="transfer-modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Transfer to Warehouse</h3>
        <button class="modal-close" id="transfer-modal-close">&times;</button>
      </div>
      
      <p>Are you sure you want to transfer the selected items to the warehouse?</p>
      <p class="muted">Selected items: <span id="transfer-count">0</span></p>
      
      <div class="form-group">
        <label>Transfer Notes (Optional):</label>
        <textarea id="transfer-notes-input" placeholder="Enter any transfer notes..."></textarea>
      </div>
      
      <div class="modal-footer">
        <button class="btn secondary" id="transfer-modal-cancel">Cancel</button>
        <button class="btn" id="transfer-confirm">Transfer Items</button>
      </div>
    </div>
  </div>
  
  <!-- Open Cash Drawer Modal -->
  <div class="modal" id="open-drawer-modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Open Cash Drawer</h3>
        <button class="modal-close" id="open-drawer-modal-close">&times;</button>
      </div>
      
      <form action="?action=open_cash_drawer" method="post" id="open-drawer-form">
        <div class="form-group">
          <label>Opening Amount ($):</label>
          <input type="number" name="amount" id="opening-amount" step="0.01" min="0" required>
        </div>
        
        <div class="form-group">
          <label>Notes (Optional):</label>
          <textarea name="notes" placeholder="Enter any notes..."></textarea>
        </div>
        
        <div class="modal-footer">
          <button type="button" class="btn secondary" id="open-drawer-modal-cancel">Cancel</button>
          <button type="submit" class="btn">Open Drawer</button>
        </div>
      </form>
    </div>
  </div>
  
  <!-- Close Cash Drawer Modal -->
  <div class="modal" id="close-drawer-modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Close Cash Drawer</h3>
        <button class="modal-close" id="close-drawer-modal-close">&times;</button>
      </div>
      
      <form action="?action=close_cash_drawer" method="post" id="close-drawer-form">
        <div class="form-group">
          <label>Closing Amount ($):</label>
          <input type="number" name="amount" id="closing-amount" step="0.01" min="0" required>
        </div>
        
        <div class="form-group">
          <label>Notes (Optional):</label>
          <textarea name="notes" placeholder="Enter any notes..."></textarea>
        </div>
        
        <div class="modal-footer">
          <button type="button" class="btn secondary" id="close-drawer-modal-cancel">Cancel</button>
          <button type="submit" class="btn danger">Close Drawer</button>
        </div>
      </form>
    </div>
  </div>
  
  <!-- Add Transaction Modal -->
  <div class="modal" id="add-transaction-modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Add Transaction</h3>
        <button class="modal-close" id="add-transaction-modal-close">&times;</button>
      </div>
      
      <form action="?action=add_transaction" method="post" id="add-transaction-form">
        <div class="form-group">
          <label>Transaction Type:</label>
          <select name="type" required>
            <option value="purchase">Purchase (Money Out)</option>
            <option value="sale">Sale (Money In)</option>
            <option value="adjustment">Adjustment</option>
          </select>
        </div>
        
        <div class="form-group">
          <label>Amount ($):</label>
          <input type="number" name="amount" id="transaction-amount" step="0.01" required>
          <p class="muted">Enter a positive amount. The system will automatically adjust the sign based on transaction type.</p>
        </div>
        
        <div class="form-group">
          <label>Notes (Optional):</label>
          <textarea name="notes" placeholder="Enter any notes..."></textarea>
        </div>
        
        <div class="modal-footer">
          <button type="button" class="btn secondary" id="add-transaction-modal-cancel">Cancel</button>
          <button type="submit" class="btn">Add Transaction</button>
        </div>
      </form>
    </div>
  </div>
  
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // Check API balance
      function checkBalance() {
        fetch('?action=check_balance')
          .then(response => response.json())
          .then(data => {
            const balanceValue = document.getElementById('balance-value');
            if (data.success) {
              balanceValue.textContent = data.balance;
            } else {
              balanceValue.textContent = 'Error';
              balanceValue.classList.add('error');
            }
          })
          .catch(error => {
            console.error('Error checking balance:', error);
            document.getElementById('balance-value').textContent = 'Error';
            document.getElementById('balance-value').classList.add('error');
          });
      }
      
      // Refresh balance button
      document.getElementById('refresh-balance').addEventListener('click', checkBalance);
      
      // Check balance on page load
      checkBalance();
      
      // Select all checkboxes
      const selectAllCheckbox = document.getElementById('select-all');
      if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', function() {
          document.querySelectorAll('.select-item').forEach(checkbox => {
            checkbox.checked = this.checked;
          });
        });
      }
      
      // Select all inventory checkboxes
      const selectAllInventoryCheckbox = document.getElementById('select-all-inventory');
      if (selectAllInventoryCheckbox) {
        selectAllInventoryCheckbox.addEventListener('change', function() {
          document.querySelectorAll('.inventory-select-item:not([disabled])').forEach(checkbox => {
            checkbox.checked = this.checked;
          });
          updateTransferCount();
        });
      }
      
      // Update transfer count
      function updateTransferCount() {
        const count = document.querySelectorAll('.inventory-select-item:checked').length;
        document.getElementById('transfer-count').textContent = count;
      }
      
      // Inventory item checkboxes
      document.querySelectorAll('.inventory-select-item').forEach(checkbox => {
        checkbox.addEventListener('change', updateTransferCount);
      });
      
      // Import to inventory button
      const importButton = document.getElementById('import-to-inventory');
      if (importButton) {
        importButton.addEventListener('click', function() {
          const selectedItems = document.querySelectorAll('.select-item:checked');
          if (selectedItems.length === 0) {
            alert('Please select at least one item to import.');
            return;
          }
          
          document.getElementById('import-modal').classList.add('show');
        });
      }
      
      // Import modal close
      document.getElementById('import-modal-close')?.addEventListener('click', function() {
        document.getElementById('import-modal').classList.remove('show');
      });
      
      document.getElementById('import-modal-cancel')?.addEventListener('click', function() {
        document.getElementById('import-modal').classList.remove('show');
      });
      
      // Import confirm
      document.getElementById('import-confirm')?.addEventListener('click', function() {
        const selectedItems = document.querySelectorAll('.select-item:checked');
        const payload = [];
        
        selectedItems.forEach(checkbox => {
          const idx = checkbox.dataset.idx;
          
          payload.push({
            imei: document.querySelector(`.imei[data-idx="${idx}"]`).value,
            manufacturer: document.querySelector(`.manufacturer[data-idx="${idx}"]`).value,
            model_name: document.querySelector(`.model-name[data-idx="${idx}"]`).value,
            model_code: document.querySelector(`.model-code[data-idx="${idx}"]`).value,
            device_display: document.querySelector(`.device-display[data-idx="${idx}"]`).value,
            condition: document.querySelector(`.condition-select[data-idx="${idx}"]`).value,
            price_paid_cents: document.querySelector(`.price-paid[data-idx="${idx}"]`).value,
            suggested_price_cents: document.querySelector(`.suggested-price[data-idx="${idx}"]`).value,
            notes: document.querySelector(`.notes[data-idx="${idx}"]`).value
          });
        });
        
        // Show loader
        document.getElementById('loader').classList.add('show');
        
        // Send import request
        fetch('?action=import_inventory', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'payload=' + encodeURIComponent(JSON.stringify(payload))
        })
        .then(response => response.json())
        .then(data => {
          document.getElementById('loader').classList.remove('show');
          document.getElementById('import-modal').classList.remove('show');
          
          // Count successes and failures
          const successes = data.results.filter(r => r.success).length;
          const failures = data.results.filter(r => !r.success).length;
          
          if (failures === 0) {
            window.location.href = '?tab=inventory&msg=imported';
          } else {
            alert(`Imported ${successes} items, but ${failures} failed.`);
            window.location.href = '?tab=inventory&error=partial_import';
          }
        })
        .catch(error => {
          console.error('Error importing items:', error);
          document.getElementById('loader').classList.remove('show');
          alert('An error occurred while importing items.');
        });
      });
      
      // Transfer to warehouse button
      document.getElementById('transfer-to-warehouse-btn')?.addEventListener('click', function() {
        const selectedItems = document.querySelectorAll('.inventory-select-item:checked');
        if (selectedItems.length === 0) {
          alert('Please select at least one item to transfer.');
          return;
        }
        
        updateTransferCount();
        document.getElementById('transfer-modal').classList.add('show');
      });
      
      // Transfer modal close
      document.getElementById('transfer-modal-close')?.addEventListener('click', function() {
        document.getElementById('transfer-modal').classList.remove('show');
      });
      
      document.getElementById('transfer-modal-cancel')?.addEventListener('click', function() {
        document.getElementById('transfer-modal').classList.remove('show');
      });
      
      // Transfer confirm
      document.getElementById('transfer-confirm')?.addEventListener('click', function() {
        document.getElementById('transfer-notes').value = document.getElementById('transfer-notes-input').value;
        document.getElementById('transfer-form').submit();
      });
      
      // Update filters
      window.updateFilters = function() {
        const status = document.getElementById('status-filter').value;
        const location = document.getElementById('location-filter').value;
        const search = new URLSearchParams(window.location.search).get('search') || '';
        
        window.location.href = `?tab=inventory&status=${status}&location=${location}&search=${encodeURIComponent(search)}`;
      };
      
      // Open cash drawer buttons
      document.getElementById('open-drawer-btn')?.addEventListener('click', function() {
        document.getElementById('open-drawer-modal').classList.add('show');
      });
      
      document.getElementById('open-drawer-btn-center')?.addEventListener('click', function() {
        document.getElementById('open-drawer-modal').classList.add('show');
      });
      
      // Open drawer modal close
      document.getElementById('open-drawer-modal-close')?.addEventListener('click', function() {
        document.getElementById('open-drawer-modal').classList.remove('show');
      });
      
      document.getElementById('open-drawer-modal-cancel')?.addEventListener('click', function() {
        document.getElementById('open-drawer-modal').classList.remove('show');
      });
      
      // Open drawer form submit
      document.getElementById('open-drawer-form')?.addEventListener('submit', function(e) {
        const amount = document.getElementById('opening-amount').value;
        if (!amount || parseFloat(amount) <= 0) {
          e.preventDefault();
          alert('Please enter a valid opening amount.');
          return;
        }
        
        // Convert dollars to cents
        document.getElementById('opening-amount').value = Math.round(parseFloat(amount) * 100);
      });
      
      // Close cash drawer button
      document.getElementById('close-drawer-btn')?.addEventListener('click', function() {
        document.getElementById('close-drawer-modal').classList.add('show');
      });
      
      // Close drawer modal close
      document.getElementById('close-drawer-modal-close')?.addEventListener('click', function() {
        document.getElementById('close-drawer-modal').classList.remove('show');
      });
      
      document.getElementById('close-drawer-modal-cancel')?.addEventListener('click', function() {
        document.getElementById('close-drawer-modal').classList.remove('show');
      });
      
      // Close drawer form submit
      document.getElementById('close-drawer-form')?.addEventListener('submit', function(e) {
        const amount = document.getElementById('closing-amount').value;
        if (!amount || parseFloat(amount) <= 0) {
          e.preventDefault();
          alert('Please enter a valid closing amount.');
          return;
        }
        
        // Convert dollars to cents
        document.getElementById('closing-amount').value = Math.round(parseFloat(amount) * 100);
      });
      
      // Add transaction button
      document.getElementById('add-transaction-btn')?.addEventListener('click', function() {
        document.getElementById('add-transaction-modal').classList.add('show');
      });
      
      // Add transaction modal close
      document.getElementById('add-transaction-modal-close')?.addEventListener('click', function() {
        document.getElementById('add-transaction-modal').classList.remove('show');
      });
      
      document.getElementById('add-transaction-modal-cancel')?.addEventListener('click', function() {
        document.getElementById('add-transaction-modal').classList.remove('show');
      });
      
      // Add transaction form submit
      document.getElementById('add-transaction-form')?.addEventListener('submit', function(e) {
        const amount = document.getElementById('transaction-amount').value;
        const type = document.querySelector('#add-transaction-form select[name="type"]').value;
        
        if (!amount || parseFloat(amount) <= 0) {
          e.preventDefault();
          alert('Please enter a valid amount.');
          return;
        }
        
        // Convert dollars to cents and adjust sign based on transaction type
        let amountCents = Math.round(parseFloat(amount) * 100);
        
        // Adjust sign based on transaction type
        if (type === 'purchase') {
          amountCents = -Math.abs(amountCents); // Negative for money out
        } else {
          amountCents = Math.abs(amountCents); // Positive for money in
        }
        
        document.getElementById('transaction-amount').value = amountCents;
      });
    });
  </script>
</body>
</html>