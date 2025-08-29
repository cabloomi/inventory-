<?php
/**
 * Database Utility Functions
 * 
 * This file contains functions for database operations
 * using SQLite for the inventory management system.
 */

declare(strict_types=1);

class Database {
    private static ?PDO $pdo = null;
    private static string $dbPath = __DIR__ . '/inventory.sqlite';
    
    /**
     * Get database connection
     * 
     * @return PDO Database connection
     */
    public static function getConnection(): PDO {
        if (self::$pdo === null) {
            $dsn = 'sqlite:' . self::$dbPath;
            self::$pdo = new PDO($dsn);
            self::$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            self::$pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
            self::$pdo->exec('PRAGMA foreign_keys = ON;');
            
            // Initialize database if it doesn't exist
            self::initializeDatabase();
        }
        
        return self::$pdo;
    }
    
    /**
     * Initialize database with schema
     */
    private static function initializeDatabase(): void {
        $schemaFile = __DIR__ . '/schema.sql';
        
        if (!file_exists(self::$dbPath) || filesize(self::$dbPath) === 0) {
            if (file_exists($schemaFile)) {
                $schema = file_get_contents($schemaFile);
                self::$pdo->exec($schema);
            } else {
                throw new Exception("Schema file not found: $schemaFile");
            }
        }
    }
    
    /**
     * Convert UTC timestamp to Eastern Time
     * 
     * @param string|null $utcTimestamp UTC timestamp
     * @return string Eastern Time timestamp
     */
    public static function convertToEasternTime(?string $utcTimestamp): string {
        if (!$utcTimestamp) {
            return '';
        }
        
        $utcDt = new DateTime($utcTimestamp, new DateTimeZone('UTC'));
        $utcDt->setTimezone(new DateTimeZone('America/New_York'));
        return $utcDt->format('Y-m-d H:i:s');
    }
    
    /**
     * Format timestamp for display
     * 
     * @param string|null $timestamp Timestamp
     * @return string Formatted timestamp
     */
    public static function formatTimestamp(?string $timestamp): string {
        if (!$timestamp) {
            return '';
        }
        
        $dt = new DateTime($timestamp);
        return $dt->format('M j, Y g:i A');
    }
    
    /**
     * Add inventory item
     * 
     * @param array $item Item data
     * @return int|false The ID of the inserted item or false on failure
     */
    public static function addInventoryItem(array $item): int|false {
        $db = self::getConnection();
        
        $sql = "INSERT INTO inventory_items (
                    imei, manufacturer, model_name, model_code, device_display,
                    color, storage, carrier, condition, icloud_lock_on,
                    price_paid_cents, suggested_price_cents, selling_price_cents,
                    status, notes, created_by, location
                ) VALUES (
                    :imei, :manufacturer, :model_name, :model_code, :device_display,
                    :color, :storage, :carrier, :condition, :icloud_lock_on,
                    :price_paid_cents, :suggested_price_cents, :selling_price_cents,
                    :status, :notes, :created_by, :location
                )";
        
        try {
            $stmt = $db->prepare($sql);
            
            // Set default values for optional fields
            $item['selling_price_cents'] = $item['selling_price_cents'] ?? $item['suggested_price_cents'] ?? 0;
            $item['status'] = $item['status'] ?? 'in_stock';
            $item['created_by'] = $item['created_by'] ?? 1; // Default to admin user
            $item['location'] = $item['location'] ?? 'store';
            $item['icloud_lock_on'] = $item['icloud_lock_on'] ?? 0;
            
            $stmt->execute([
                ':imei' => $item['imei'],
                ':manufacturer' => $item['manufacturer'] ?? '',
                ':model_name' => $item['model_name'] ?? '',
                ':model_code' => $item['model_code'] ?? '',
                ':device_display' => $item['device_display'] ?? '',
                ':color' => $item['color'] ?? '',
                ':storage' => $item['storage'] ?? '',
                ':carrier' => $item['carrier'] ?? '',
                ':condition' => $item['condition'] ?? '',
                ':icloud_lock_on' => $item['icloud_lock_on'] ? 1 : 0,
                ':price_paid_cents' => $item['price_paid_cents'] ?? 0,
                ':suggested_price_cents' => $item['suggested_price_cents'] ?? 0,
                ':selling_price_cents' => $item['selling_price_cents'],
                ':status' => $item['status'],
                ':notes' => $item['notes'] ?? '',
                ':created_by' => $item['created_by'],
                ':location' => $item['location']
            ]);
            
            return (int)$db->lastInsertId();
        } catch (PDOException $e) {
            error_log("Database error: " . $e->getMessage());
            return false;
        }
    }
    
    /**
     * Get inventory items
     * 
     * @param array $filters Filter criteria
     * @param int $limit Maximum number of items to return
     * @param int $offset Offset for pagination
     * @return array Array of inventory items
     */
    public static function getInventoryItems(array $filters = [], int $limit = 100, int $offset = 0): array {
        $db = self::getConnection();
        
        $whereClauses = [];
        $params = [];
        
        // Build WHERE clause based on filters
        if (!empty($filters['status'])) {
            $whereClauses[] = "status = :status";
            $params[':status'] = $filters['status'];
        }
        
        if (!empty($filters['location'])) {
            $whereClauses[] = "location = :location";
            $params[':location'] = $filters['location'];
        }
        
        if (!empty($filters['search'])) {
            $whereClauses[] = "(imei LIKE :search OR device_display LIKE :search OR model_name LIKE :search)";
            $params[':search'] = '%' . $filters['search'] . '%';
        }
        
        $whereClause = !empty($whereClauses) ? "WHERE " . implode(" AND ", $whereClauses) : "";
        
        $sql = "SELECT * FROM inventory_items 
                $whereClause 
                ORDER BY created_at DESC 
                LIMIT :limit OFFSET :offset";
        
        try {
            $stmt = $db->prepare($sql);
            
            // Bind parameters
            foreach ($params as $key => $value) {
                $stmt->bindValue($key, $value);
            }
            
            $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
            $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
            
            $stmt->execute();
            return $stmt->fetchAll();
        } catch (PDOException $e) {
            error_log("Database error: " . $e->getMessage());
            return [];
        }
    }
    
    /**
     * Get inventory item by ID
     * 
     * @param int $id Item ID
     * @return array|null Item data or null if not found
     */
    public static function getInventoryItemById(int $id): ?array {
        $db = self::getConnection();
        
        $sql = "SELECT * FROM inventory_items WHERE id = :id";
        
        try {
            $stmt = $db->prepare($sql);
            $stmt->bindValue(':id', $id, PDO::PARAM_INT);
            $stmt->execute();
            
            $item = $stmt->fetch();
            return $item ?: null;
        } catch (PDOException $e) {
            error_log("Database error: " . $e->getMessage());
            return null;
        }
    }
    
    /**
     * Update inventory item
     * 
     * @param int $id Item ID
     * @param array $data Updated item data
     * @return bool Success status
     */
    public static function updateInventoryItem(int $id, array $data): bool {
        $db = self::getConnection();
        
        // Build SET clause
        $setClauses = [];
        $params = [':id' => $id];
        
        foreach ($data as $key => $value) {
            if ($key !== 'id' && $key !== 'created_at') {
                $setClauses[] = "$key = :$key";
                $params[":$key"] = $value;
            }
        }
        
        // Always update the updated_at timestamp
        $setClauses[] = "updated_at = CURRENT_TIMESTAMP";
        
        $setClause = implode(", ", $setClauses);
        
        $sql = "UPDATE inventory_items SET $setClause WHERE id = :id";
        
        try {
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            
            return $stmt->rowCount() > 0;
        } catch (PDOException $e) {
            error_log("Database error: " . $e->getMessage());
            return false;
        }
    }
    
    /**
     * Open cash drawer
     * 
     * @param int $openingAmountCents Opening amount in cents
     * @param int $userId User ID who opened the drawer
     * @param string $notes Optional notes
     * @return int|false The ID of the cash drawer or false on failure
     */
    public static function openCashDrawer(int $openingAmountCents, int $userId, string $notes = ''): int|false {
        $db = self::getConnection();
        
        // Check if there's already an open cash drawer
        $sql = "SELECT id FROM cash_drawer WHERE status = 'open'";
        $stmt = $db->query($sql);
        
        if ($stmt->fetch()) {
            // There's already an open cash drawer
            return false;
        }
        
        $sql = "INSERT INTO cash_drawer (opening_amount_cents, expected_amount_cents, opened_by, notes) 
                VALUES (:opening_amount_cents, :expected_amount_cents, :opened_by, :notes)";
        
        try {
            $stmt = $db->prepare($sql);
            $stmt->execute([
                ':opening_amount_cents' => $openingAmountCents,
                ':expected_amount_cents' => $openingAmountCents,
                ':opened_by' => $userId,
                ':notes' => $notes
            ]);
            
            return (int)$db->lastInsertId();
        } catch (PDOException $e) {
            error_log("Database error: " . $e->getMessage());
            return false;
        }
    }
    
    /**
     * Close cash drawer
     * 
     * @param int $closingAmountCents Closing amount in cents
     * @param int $userId User ID who closed the drawer
     * @param string $notes Optional notes
     * @return bool Success status
     */
    public static function closeCashDrawer(int $closingAmountCents, int $userId, string $notes = ''): bool {
        $db = self::getConnection();
        
        // Get the open cash drawer
        $sql = "SELECT id, expected_amount_cents FROM cash_drawer WHERE status = 'open'";
        $stmt = $db->query($sql);
        $drawer = $stmt->fetch();
        
        if (!$drawer) {
            // No open cash drawer
            return false;
        }
        
        $difference = $closingAmountCents - $drawer['expected_amount_cents'];
        
        $sql = "UPDATE cash_drawer 
                SET closing_amount_cents = :closing_amount_cents, 
                    difference_cents = :difference_cents,
                    status = 'closed', 
                    closed_at = CURRENT_TIMESTAMP, 
                    closed_by = :closed_by, 
                    notes = CASE WHEN notes = '' THEN :notes ELSE notes || '; ' || :notes END
                WHERE id = :id";
        
        try {
            $stmt = $db->prepare($sql);
            $stmt->execute([
                ':closing_amount_cents' => $closingAmountCents,
                ':difference_cents' => $difference,
                ':closed_by' => $userId,
                ':notes' => $notes,
                ':id' => $drawer['id']
            ]);
            
            return $stmt->rowCount() > 0;
        } catch (PDOException $e) {
            error_log("Database error: " . $e->getMessage());
            return false;
        }
    }
    
    /**
     * Record cash transaction
     * 
     * @param int $amount Amount in cents (positive for inflow, negative for outflow)
     * @param string $type Transaction type
     * @param int|null $referenceId Reference ID
     * @param int $userId User ID
     * @param string $notes Optional notes
     * @return int|false The ID of the transaction or false on failure
     */
    public static function recordCashTransaction(int $amount, string $type, ?int $referenceId, int $userId, string $notes = ''): int|false {
        $db = self::getConnection();
        
        // Get the open cash drawer
        $sql = "SELECT id, expected_amount_cents FROM cash_drawer WHERE status = 'open'";
        $stmt = $db->query($sql);
        $drawer = $stmt->fetch();
        
        if (!$drawer) {
            // No open cash drawer
            return false;
        }
        
        // Start transaction
        $db->beginTransaction();
        
        try {
            // Insert transaction
            $sql = "INSERT INTO cash_transactions (cash_drawer_id, amount_cents, transaction_type, reference_id, notes, created_by) 
                    VALUES (:cash_drawer_id, :amount_cents, :transaction_type, :reference_id, :notes, :created_by)";
            
            $stmt = $db->prepare($sql);
            $stmt->execute([
                ':cash_drawer_id' => $drawer['id'],
                ':amount_cents' => $amount,
                ':transaction_type' => $type,
                ':reference_id' => $referenceId,
                ':notes' => $notes,
                ':created_by' => $userId
            ]);
            
            $transactionId = (int)$db->lastInsertId();
            
            // Update expected amount in cash drawer
            $newExpectedAmount = $drawer['expected_amount_cents'] + $amount;
            
            $sql = "UPDATE cash_drawer 
                    SET expected_amount_cents = :expected_amount_cents 
                    WHERE id = :id";
            
            $stmt = $db->prepare($sql);
            $stmt->execute([
                ':expected_amount_cents' => $newExpectedAmount,
                ':id' => $drawer['id']
            ]);
            
            // Commit transaction
            $db->commit();
            
            return $transactionId;
        } catch (PDOException $e) {
            // Rollback transaction
            $db->rollBack();
            error_log("Database error: " . $e->getMessage());
            return false;
        }
    }
    
    /**
     * Create warehouse transfer
     * 
     * @param array $itemIds Array of inventory item IDs to transfer
     * @param int $userId User ID who created the transfer
     * @param string $notes Optional notes
     * @return int|false The ID of the transfer or false on failure
     */
    public static function createWarehouseTransfer(array $itemIds, int $userId, string $notes = ''): int|false {
        if (empty($itemIds)) {
            return false;
        }
        
        $db = self::getConnection();
        
        // Start transaction
        $db->beginTransaction();
        
        try {
            // Create transfer record
            $sql = "INSERT INTO warehouse_transfers (notes, created_by) VALUES (:notes, :created_by)";
            
            $stmt = $db->prepare($sql);
            $stmt->execute([
                ':notes' => $notes,
                ':created_by' => $userId
            ]);
            
            $transferId = (int)$db->lastInsertId();
            
            // Add items to transfer
            $sql = "INSERT INTO warehouse_transfer_items (transfer_id, inventory_item_id) VALUES (:transfer_id, :inventory_item_id)";
            $stmt = $db->prepare($sql);
            
            foreach ($itemIds as $itemId) {
                $stmt->execute([
                    ':transfer_id' => $transferId,
                    ':inventory_item_id' => $itemId
                ]);
                
                // Update inventory item status
                $updateSql = "UPDATE inventory_items SET status = 'transferred_to_warehouse' WHERE id = :id";
                $updateStmt = $db->prepare($updateSql);
                $updateStmt->execute([':id' => $itemId]);
            }
            
            // Commit transaction
            $db->commit();
            
            return $transferId;
        } catch (PDOException $e) {
            // Rollback transaction
            $db->rollBack();
            error_log("Database error: " . $e->getMessage());
            return false;
        }
    }
    
    /**
     * Get active cash drawer
     * 
     * @return array|null Cash drawer data or null if no active drawer
     */
    public static function getActiveCashDrawer(): ?array {
        $db = self::getConnection();
        
        $sql = "SELECT * FROM cash_drawer WHERE status = 'open'";
        
        try {
            $stmt = $db->query($sql);
            $drawer = $stmt->fetch();
            
            if ($drawer) {
                // Get transactions for this drawer
                $sql = "SELECT * FROM cash_transactions WHERE cash_drawer_id = :drawer_id ORDER BY created_at DESC";
                $stmt = $db->prepare($sql);
                $stmt->execute([':drawer_id' => $drawer['id']]);
                $transactions = $stmt->fetchAll();
                
                $drawer['transactions'] = $transactions;
            }
            
            return $drawer ?: null;
        } catch (PDOException $e) {
            error_log("Database error: " . $e->getMessage());
            return null;
        }
    }
    
    /**
     * Log audit event
     * 
     * @param int $userId User ID
     * @param string $action Action performed
     * @param string $entityType Entity type
     * @param int $entityId Entity ID
     * @param string $details Additional details
     * @return bool Success status
     */
    public static function logAudit(int $userId, string $action, string $entityType, int $entityId, string $details = ''): bool {
        $db = self::getConnection();
        
        $sql = "INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) 
                VALUES (:user_id, :action, :entity_type, :entity_id, :details)";
        
        try {
            $stmt = $db->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':action' => $action,
                ':entity_type' => $entityType,
                ':entity_id' => $entityId,
                ':details' => $details
            ]);
            
            return true;
        } catch (PDOException $e) {
            error_log("Database error: " . $e->getMessage());
            return false;
        }
    }
}