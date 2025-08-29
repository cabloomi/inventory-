<?php
/**
 * Warehouse Portal for Enhanced Inventory Management System
 * 
 * Features:
 * - View and manage warehouse inventory
 * - Receive transfers from store
 * - Add inventory manually
 * - Organize inventory
 */

declare(strict_types=1);
ini_set('display_errors', '1');
error_reporting(E_ALL);

// Include database utilities
require_once __DIR__ . '/database/db.php';

// Default user ID (in a real app, this would come from authentication)
$CURRENT_USER_ID = 1;

// ------------------- HELPERS -------------------
function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }

function formatMoney($cents) {
  return '$' . number_format($cents / 100, 2);
}

// ------------------- ROUTING -------------------
$action = $_GET['action'] ?? '';

// Handle receiving transfers
if ($action === 'receive_transfer') {
  $transferId = (int)($_POST['transfer_id'] ?? 0);
  $notes = $_POST['notes'] ?? '';
  
  if ($transferId > 0) {
    // Update transfer status
    $db = Database::getConnection();
    
    try {
      // Start transaction
      $db->beginTransaction();
      
      // Update transfer status
      $sql = "UPDATE warehouse_transfers 
              SET status = 'completed', received_by = :user_id, received_at = CURRENT_TIMESTAMP, 
                  notes = CASE WHEN notes = '' THEN :notes ELSE notes || '; ' || :notes END
              WHERE id = :id";
      
      $stmt = $db->prepare($sql);
      $stmt->execute([
        ':user_id' => $CURRENT_USER_ID,
        ':notes' => $notes,
        ':id' => $transferId
      ]);
      
      // Update transfer items status
      $sql = "UPDATE warehouse_transfer_items SET status = 'received' WHERE transfer_id = :transfer_id";
      $stmt = $db->prepare($sql);
      $stmt->execute([':transfer_id' => $transferId]);
      
      // Update inventory items location
      $sql = "UPDATE inventory_items 
              SET location = 'warehouse', status = 'in_stock' 
              WHERE id IN (
                SELECT inventory_item_id FROM warehouse_transfer_items WHERE transfer_id = :transfer_id
              )";
      $stmt = $db->prepare($sql);
      $stmt->execute([':transfer_id' => $transferId]);
      
      // Log audit
      Database::logAudit(
        $CURRENT_USER_ID,
        'receive',
        'warehouse_transfer',
        $transferId,
        "Received transfer #$transferId"
      );
      
      // Commit transaction
      $db->commit();
      
      header('Location: warehouse.php?msg=received');
    } catch (PDOException $e) {
      // Rollback transaction
      $db->rollBack();
      header('Location: warehouse.php?error=failed_to_receive');
    }
  } else {
    header('Location: warehouse.php?error=invalid_transfer');
  }
  exit;
}

// Handle adding inventory manually
if ($action === 'add_inventory') {
  $deviceDisplay = $_POST['device_display'] ?? '';
  $imei = $_POST['imei'] ?? '';
  $manufacturer = $_POST['manufacturer'] ?? '';
  $modelName = $_POST['model_name'] ?? '';
  $modelCode = $_POST['model_code'] ?? '';
  $color = $_POST['color'] ?? '';
  $storage = $_POST['storage'] ?? '';
  $carrier = $_POST['carrier'] ?? '';
  $condition = $_POST['condition'] ?? '';
  $pricePaidCents = (int)($_POST['price_paid_cents'] ?? 0);
  $sellingPriceCents = (int)($_POST['selling_price_cents'] ?? 0);
  $notes = $_POST['notes'] ?? '';
  
  if ($deviceDisplay && $imei) {
    // Add to inventory
    $inventoryItem = [
      'imei' => $imei,
      'manufacturer' => $manufacturer,
      'model_name' => $modelName,
      'model_code' => $modelCode,
      'device_display' => $deviceDisplay,
      'color' => $color,
      'storage' => $storage,
      'carrier' => $carrier,
      'condition' => $condition,
      'price_paid_cents' => $pricePaidCents,
      'selling_price_cents' => $sellingPriceCents,
      'notes' => $notes,
      'created_by' => $CURRENT_USER_ID,
      'location' => 'warehouse'
    ];
    
    $id = Database::addInventoryItem($inventoryItem);
    if ($id) {
      // Log audit
      Database::logAudit(
        $CURRENT_USER_ID,
        'add',
        'inventory_item',
        $id,
        "Manually added item to warehouse: $deviceDisplay"
      );
      
      header('Location: warehouse.php?msg=added');
    } else {
      header('Location: warehouse.php?error=failed_to_add');
    }
  } else {
    header('Location: warehouse.php?error=missing_fields');
  }
  exit;
}

// ------------------- MAIN UI -------------------
$activeTab = $_GET['tab'] ?? 'inventory';
$inventoryItems = [];
$pendingTransfers = [];

// Get warehouse inventory
if ($activeTab === 'inventory') {
  $filters = [
    'status' => $_GET['status'] ?? 'in_stock',
    'location' => 'warehouse',
    'search' => $_GET['search'] ?? ''
  ];
  
  $page = max(1, (int)($_GET['page'] ?? 1));
  $limit = 50;
  $offset = ($page - 1) * $limit;
  
  $inventoryItems = Database::getInventoryItems($filters, $limit, $offset);
}

// Get pending transfers
if ($activeTab === 'transfers') {
  $db = Database::getConnection();
  
  $sql = "SELECT wt.*, u.username as created_by_name,
          (SELECT COUNT(*) FROM warehouse_transfer_items wti WHERE wti.transfer_id = wt.id) as item_count
          FROM warehouse_transfers wt
          LEFT JOIN users u ON wt.created_by = u.id
          WHERE wt.status = 'pending'
          ORDER BY wt.transfer_date DESC";
  
  $stmt = $db->query($sql);
  $pendingTransfers = $stmt->fetchAll();
  
  // Get transfer details if viewing a specific transfer
  $viewTransferId = (int)($_GET['view_transfer'] ?? 0);
  if ($viewTransferId > 0) {
    $sql = "SELECT wt.*, u.username as created_by_name
            FROM warehouse_transfers wt
            LEFT JOIN users u ON wt.created_by = u.id
            WHERE wt.id = :id";
    
    $stmt = $db->prepare($sql);
    $stmt->execute([':id' => $viewTransferId]);
    $transferDetails = $stmt->fetch();
    
    if ($transferDetails) {
      $sql = "SELECT wti.*, i.*
              FROM warehouse_transfer_items wti
              JOIN inventory_items i ON wti.inventory_item_id = i.id
              WHERE wti.transfer_id = :transfer_id";
      
      $stmt = $db->prepare($sql);
      $stmt->execute([':transfer_id' => $viewTransferId]);
      $transferItems = $stmt->fetchAll();
    }
  }
}

?>
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Warehouse Portal</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <style>
    :root {
      --primary: #4a6fa5;
      --primary-dark: #3a5a8c;
      --secondary: #2d3748;
      --secondary-light: #3d4a5f;
      --background: #f7fafc;
      --card-bg: #ffffff;
      --input-bg: #edf2f7;
      --border: #e2e8f0;
      --text: #2d3748;
      --text-muted: #718096;
      --success: #48bb78;
      --error: #f56565;
      --warning: #ed8936;
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
      color: var(--primary);
    }
    
    .header-right {
      display: flex;
      align-items: center;
      gap: 15px;
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
      color: #fff;
      text-decoration: none;
    }
    
    .tab.active {
      background: var(--primary);
      color: #fff;
    }
    
    .tab:hover:not(.active) {
      background: var(--secondary-light);
    }
    
    .tab i {
      margin-right: 8px;
    }
    
    .card {
      background: var(--card-bg);
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
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
      color: var(--primary);
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
      color: #fff;
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
      color: #fff;
    }
    
    .btn.secondary:hover {
      background: var(--secondary-light);
    }
    
    .btn.success {
      background: var(--success);
      color: #fff;
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
      background: rgba(0,0,0,0.02);
    }
    
    .tag {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--secondary);
      color: #fff;
      font-size: 12px;
      font-weight: 500;
    }
    
    .tag.success {
      background: var(--success);
    }
    
    .tag.error {
      background: var(--error);
    }
    
    .tag.warning {
      background: var(--warning);
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
      background: rgba(72, 187, 120, 0.1);
      border: 1px solid rgba(72, 187, 120, 0.2);
      color: var(--success);
    }
    
    .alert.error {
      background: rgba(245, 101, 101, 0.1);
      border: 1px solid rgba(245, 101, 101, 0.2);
      color: var(--error);
    }
    
    .alert.warning {
      background: rgba(237, 137, 54, 0.1);
      border: 1px solid rgba(237, 137, 54, 0.2);
      color: var(--warning);
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
    
    .pagination {
      display: flex;
      justify-content: center;
      gap: 5px;
      margin-top: 20px;
    }
    
    .pagination a {
      padding: 8px 12px;
      background: var(--secondary);
      color: #fff;
      border-radius: 6px;
      text-decoration: none;
    }
    
    .pagination a.active {
      background: var(--primary);
    }
    
    .transfer-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
    }
    
    .transfer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    
    .transfer-title {
      font-weight: 600;
      font-size: 16px;
    }
    
    .transfer-meta {
      display: flex;
      justify-content: space-between;
      color: var(--text-muted);
      font-size: 14px;
      margin-bottom: 10px;
    }
    
    .transfer-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 10px;
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
      color: var(--primary);
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
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 15px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><i class="fas fa-warehouse"></i> Warehouse Portal</h1>
      <div class="header-right">
        <a href="index.enhanced.php" class="btn secondary">
          <i class="fas fa-store"></i> Go to Store
        </a>
      </div>
    </div>
    
    <div class="tabs">
      <a href="?tab=inventory" class="tab <?= $activeTab === 'inventory' ? 'active' : '' ?>">
        <i class="fas fa-boxes"></i> Inventory
      </a>
      <a href="?tab=transfers" class="tab <?= $activeTab === 'transfers' ? 'active' : '' ?>">
        <i class="fas fa-truck-loading"></i> Transfers
        <?php if (count($pendingTransfers) > 0): ?>
          <span class="tag warning"><?= count($pendingTransfers) ?></span>
        <?php endif; ?>
      </a>
      <a href="?tab=add" class="tab <?= $activeTab === 'add' ? 'active' : '' ?>">
        <i class="fas fa-plus"></i> Add Inventory
      </a>
    </div>
    
    <?php if (isset($_GET['msg'])): ?>
      <div class="alert success">
        <i class="fas fa-check-circle"></i>
        <?php if ($_GET['msg'] === 'received'): ?>
          Transfer successfully received.
        <?php elseif ($_GET['msg'] === 'added'): ?>
          Inventory item successfully added.
        <?php else: ?>
          Operation completed successfully.
        <?php endif; ?>
      </div>
    <?php endif; ?>
    
    <?php if (isset($_GET['error'])): ?>
      <div class="alert error">
        <i class="fas fa-exclamation-circle"></i>
        <?php if ($_GET['error'] === 'failed_to_receive'): ?>
          Failed to receive transfer.
        <?php elseif ($_GET['error'] === 'invalid_transfer'): ?>
          Invalid transfer ID.
        <?php elseif ($_GET['error'] === 'failed_to_add'): ?>
          Failed to add inventory item.
        <?php elseif ($_GET['error'] === 'missing_fields'): ?>
          Please fill in all required fields.
        <?php else: ?>
          An error occurred during the operation.
        <?php endif; ?>
      </div>
    <?php endif; ?>
    
    <?php if ($activeTab === 'inventory'): ?>
      <!-- Inventory Tab -->
      <div class="card">
        <div class="card-header">
          <h2>Warehouse Inventory</h2>
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
              <option value="all" <?= ($_GET['status'] ?? '') === 'all' ? 'selected' : '' ?>>All</option>
            </select>
          </div>
        </div>
        
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
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
                  <td colspan="7" style="text-align: center; padding: 30px;">
                    <i class="fas fa-box-open" style="font-size: 24px; margin-bottom: 10px; display: block; opacity: 0.5;"></i>
                    No inventory items found.
                  </td>
                </tr>
              <?php else: ?>
                <?php foreach ($inventoryItems as $item): ?>
                  <tr>
                    <td><code><?= h($item['imei']) ?></code></td>
                    <td><?= h($item['device_display']) ?></td>
                    <td><?= h($item['condition']) ?></td>
                    <td><?= formatMoney($item['price_paid_cents']) ?></td>
                    <td>
                      <?php if ($item['status'] === 'in_stock'): ?>
                        <span class="tag success">In Stock</span>
                      <?php elseif ($item['status'] === 'sold'): ?>
                        <span class="tag">Sold</span>
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
    
    <?php if ($activeTab === 'transfers'): ?>
      <!-- Transfers Tab -->
      <div class="card">
        <div class="card-header">
          <h2>Pending Transfers</h2>
        </div>
        
        <?php if (isset($transferDetails) && isset($transferItems)): ?>
          <!-- Transfer Details -->
          <div class="card">
            <div class="card-header">
              <h3>Transfer #<?= $transferDetails['id'] ?> Details</h3>
              <a href="?tab=transfers" class="btn secondary sm">
                <i class="fas fa-arrow-left"></i> Back to Transfers
              </a>
            </div>
            
            <div class="row">
              <div class="col">
                <p><strong>Created By:</strong> <?= h($transferDetails['created_by_name']) ?></p>
                <p><strong>Date:</strong> <?= Database::formatTimestamp(Database::convertToEasternTime($transferDetails['transfer_date'])) ?></p>
              </div>
              <div class="col">
                <p><strong>Status:</strong> <span class="tag warning">Pending</span></p>
                <p><strong>Notes:</strong> <?= h($transferDetails['notes'] ?: 'None') ?></p>
              </div>
            </div>
            
            <h4 style="margin-top: 20px;">Items (<?= count($transferItems) ?>)</h4>
            
            <div class="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>IMEI</th>
                    <th>Device</th>
                    <th>Condition</th>
                    <th>Price Paid</th>
                  </tr>
                </thead>
                <tbody>
                  <?php foreach ($transferItems as $item): ?>
                    <tr>
                      <td><code><?= h($item['imei']) ?></code></td>
                      <td><?= h($item['device_display']) ?></td>
                      <td><?= h($item['condition']) ?></td>
                      <td><?= formatMoney($item['price_paid_cents']) ?></td>
                    </tr>
                  <?php endforeach; ?>
                </tbody>
              </table>
            </div>
            
            <div style="margin-top: 20px; text-align: right;">
              <button class="btn success" id="receive-transfer-btn" data-id="<?= $transferDetails['id'] ?>">
                <i class="fas fa-check-circle"></i> Receive Transfer
              </button>
            </div>
          </div>
        <?php elseif (empty($pendingTransfers)): ?>
          <div style="text-align: center; padding: 50px 20px;">
            <i class="fas fa-truck-loading" style="font-size: 48px; margin-bottom: 20px; display: block; opacity: 0.5;"></i>
            <h3 style="margin-bottom: 10px;">No Pending Transfers</h3>
            <p class="muted">There are no pending transfers from the store.</p>
          </div>
        <?php else: ?>
          <!-- Pending Transfers List -->
          <div class="grid">
            <?php foreach ($pendingTransfers as $transfer): ?>
              <div class="transfer-card">
                <div class="transfer-header">
                  <div class="transfer-title">Transfer #<?= $transfer['id'] ?></div>
                  <span class="tag warning">Pending</span>
                </div>
                
                <div class="transfer-meta">
                  <div>Items: <?= $transfer['item_count'] ?></div>
                  <div><?= Database::formatTimestamp(Database::convertToEasternTime($transfer['transfer_date'])) ?></div>
                </div>
                
                <?php if ($transfer['notes']): ?>
                  <div class="muted"><?= h($transfer['notes']) ?></div>
                <?php endif; ?>
                
                <div class="transfer-actions">
                  <a href="?tab=transfers&view_transfer=<?= $transfer['id'] ?>" class="btn secondary sm">
                    <i class="fas fa-eye"></i> View Details
                  </a>
                </div>
              </div>
            <?php endforeach; ?>
          </div>
        <?php endif; ?>
      </div>
    <?php endif; ?>
    
    <?php if ($activeTab === 'add'): ?>
      <!-- Add Inventory Tab -->
      <div class="card">
        <div class="card-header">
          <h2>Add Inventory Item</h2>
        </div>
        
        <form action="?action=add_inventory" method="post">
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>Device Name *</label>
                <input type="text" name="device_display" required placeholder="e.g., iPhone 13 Pro">
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>IMEI/Serial Number *</label>
                <input type="text" name="imei" required placeholder="e.g., 123456789012345">
              </div>
            </div>
          </div>
          
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>Manufacturer</label>
                <input type="text" name="manufacturer" placeholder="e.g., Apple">
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>Model Name</label>
                <input type="text" name="model_name" placeholder="e.g., iPhone 13 Pro">
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>Model Code</label>
                <input type="text" name="model_code" placeholder="e.g., A2483">
              </div>
            </div>
          </div>
          
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>Color</label>
                <input type="text" name="color" placeholder="e.g., Sierra Blue">
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>Storage</label>
                <input type="text" name="storage" placeholder="e.g., 256GB">
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>Carrier</label>
                <input type="text" name="carrier" placeholder="e.g., Unlocked">
              </div>
            </div>
          </div>
          
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>Condition</label>
                <select name="condition">
                  <option value="A">A - Like New</option>
                  <option value="B" selected>B - Good</option>
                  <option value="C">C - Fair</option>
                  <option value="D">D - Poor</option>
                </select>
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>Price Paid ($)</label>
                <input type="number" name="price_paid_cents" step="0.01" min="0" placeholder="e.g., 500.00">
                <p class="muted">Enter in dollars, will be converted to cents.</p>
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>Selling Price ($)</label>
                <input type="number" name="selling_price_cents" step="0.01" min="0" placeholder="e.g., 700.00">
                <p class="muted">Enter in dollars, will be converted to cents.</p>
              </div>
            </div>
          </div>
          
          <div class="form-group">
            <label>Notes</label>
            <textarea name="notes" placeholder="Enter any additional notes..."></textarea>
          </div>
          
          <div style="text-align: right;">
            <button type="submit" class="btn">
              <i class="fas fa-plus"></i> Add to Inventory
            </button>
          </div>
        </form>
      </div>
    <?php endif; ?>
  </div>
  
  <!-- Receive Transfer Modal -->
  <div class="modal" id="receive-transfer-modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Receive Transfer</h3>
        <button class="modal-close" id="receive-transfer-modal-close">&times;</button>
      </div>
      
      <form action="?action=receive_transfer" method="post" id="receive-transfer-form">
        <input type="hidden" name="transfer_id" id="transfer-id">
        
        <p>Are you sure you want to receive this transfer? This will update the inventory items to be located in the warehouse.</p>
        
        <div class="form-group">
          <label>Notes (Optional):</label>
          <textarea name="notes" placeholder="Enter any notes..."></textarea>
        </div>
        
        <div class="modal-footer">
          <button type="button" class="btn secondary" id="receive-transfer-modal-cancel">Cancel</button>
          <button type="submit" class="btn success">Receive Transfer</button>
        </div>
      </form>
    </div>
  </div>
  
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // Update filters
      window.updateFilters = function() {
        const status = document.getElementById('status-filter').value;
        const search = new URLSearchParams(window.location.search).get('search') || '';
        
        window.location.href = `?tab=inventory&status=${status}&search=${encodeURIComponent(search)}`;
      };
      
      // Receive transfer button
      const receiveTransferBtn = document.getElementById('receive-transfer-btn');
      if (receiveTransferBtn) {
        receiveTransferBtn.addEventListener('click', function() {
          const transferId = this.dataset.id;
          document.getElementById('transfer-id').value = transferId;
          document.getElementById('receive-transfer-modal').classList.add('show');
        });
      }
      
      // Receive transfer modal close
      document.getElementById('receive-transfer-modal-close')?.addEventListener('click', function() {
        document.getElementById('receive-transfer-modal').classList.remove('show');
      });
      
      document.getElementById('receive-transfer-modal-cancel')?.addEventListener('click', function() {
        document.getElementById('receive-transfer-modal').classList.remove('show');
      });
      
      // Form submission for dollar to cents conversion
      document.querySelector('form[action="?action=add_inventory"]')?.addEventListener('submit', function(e) {
        const pricePaid = document.querySelector('input[name="price_paid_cents"]').value;
        const sellingPrice = document.querySelector('input[name="selling_price_cents"]').value;
        
        if (pricePaid) {
          document.querySelector('input[name="price_paid_cents"]').value = Math.round(parseFloat(pricePaid) * 100);
        }
        
        if (sellingPrice) {
          document.querySelector('input[name="selling_price_cents"]').value = Math.round(parseFloat(sellingPrice) * 100);
        }
      });
    });
  </script>
</body>
</html>