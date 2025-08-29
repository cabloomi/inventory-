# Enhanced Inventory Management System

A comprehensive inventory management system for retail stores with warehouse integration, cash drawer management, and Eastern Time timestamps.

## Features

### Inventory Management
- **Bulk IMEI Lookup**: Quickly look up device information using IMEI numbers
- **Auto-Pricing**: Automatically suggest prices based on device matching
- **Direct Import**: Import devices directly into inventory
- **Inventory Tracking**: Track inventory status and location
- **Eastern Time Timestamps**: All timestamps are displayed in Eastern Time

### Cash Drawer Management
- **Cash Drawer Tracking**: Open and close cash drawers with balance tracking
- **Transaction Recording**: Record purchases, sales, and adjustments
- **Balance Reporting**: View current balance and transaction history
- **Discrepancy Tracking**: Track differences between expected and actual amounts

### Warehouse Integration
- **Warehouse Portal**: Dedicated interface for warehouse operations
- **Transfer System**: Transfer inventory between store and warehouse
- **Manual Entry**: Add inventory items directly to warehouse
- **Transfer Tracking**: Track status of transfers between locations

## System Requirements

- PHP 8.0 or higher
- SQLite database
- Web server with PHP support
- Internet connection for IMEI lookups

## Installation

1. Clone the repository to your web server
2. Ensure the `database` directory is writable by the web server
3. Access `index.enhanced.php` in your web browser
4. The system will automatically initialize the database on first run

## Configuration

The system can be configured by modifying the following variables at the top of `index.enhanced.php`:

```php
$SICKW_API_URL   = 'https://sickw.com/api.php';
$SICKW_API_KEY   = getenv('SICKW_API_KEY') ?: 'YOUR_API_KEY';
$SICKW_SERVICEID = getenv('SICKW_SERVICE_ID') ?: '6';
$SICKW_FORMAT    = 'beta';
$PRICES_CSV_URL  = 'https://allenslists.pages.dev/data/prices.csv';
```

For production use, it's recommended to set these values using environment variables.

## Usage

### Store Interface (index.enhanced.php)

The store interface provides the following tabs:

1. **Lookup**: Look up device information by IMEI and import to inventory
2. **Inventory**: View and manage store inventory, transfer items to warehouse
3. **Cash Drawer**: Manage cash drawer operations and transactions
4. **Warehouse**: Quick access to warehouse information

### Warehouse Interface (warehouse.php)

The warehouse interface provides the following tabs:

1. **Inventory**: View and manage warehouse inventory
2. **Transfers**: Receive transfers from the store
3. **Add Inventory**: Manually add items to warehouse inventory

## Database Schema

The system uses an SQLite database with the following main tables:

- `inventory_items`: Stores all inventory items
- `cash_drawer`: Tracks cash drawer sessions
- `cash_transactions`: Records all cash transactions
- `warehouse_transfers`: Tracks transfers between store and warehouse
- `warehouse_transfer_items`: Links inventory items to transfers
- `users`: Stores user information
- `sales`: Records sales transactions
- `sale_items`: Links inventory items to sales
- `audit_log`: Tracks all system actions for accountability

## Security

- The system includes basic user authentication
- Passwords are stored using secure hashing
- All user actions are logged in the audit log
- API keys should be stored as environment variables in production

## Optimizations

### 1. Code Organization

- **Modular Architecture**: Reorganized code into utility modules for better reusability and maintainability
- **Shared Utilities**: Created common utilities for CSV parsing, string operations, device matching, API handling, and caching
- **Consistent Patterns**: Standardized error handling, response formatting, and data processing across the codebase

### 2. Performance Improvements

- **Optimized CSV Parsing**: Replaced custom CSV parsing with more efficient implementations
- **Improved String Operations**: Enhanced string normalization and comparison functions
- **Better Device Matching**: More accurate and efficient device matching algorithms
- **Caching Mechanisms**: Added memory caching for frequently accessed data
- **Parallel Processing**: Implemented batch processing for handling multiple IMEIs concurrently
- **Optimized Levenshtein Distance**: Enhanced string similarity calculations with early termination

### 3. Utility Modules

- **CSV Utilities**: Efficient CSV parsing and manipulation
- **String Utilities**: Text normalization, Levenshtein distance calculation, and string similarity scoring
- **Device Matcher**: Improved device matching algorithms and brand/model identification
- **API Utilities**: Consistent response formatting and error handling
- **Cache Utilities**: In-memory caching with expiration and function memoization

## License

This software is proprietary and confidential. Unauthorized copying, distribution, or use is prohibited.