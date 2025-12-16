// Backup and Restore Service
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { isPostgreSQL, pool } = require('./database-pg');
const { ProductionDatabase } = require('./production-database');

const execAsync = promisify(exec);

class BackupService {
    constructor() {
        // Backup storage directory
        this.backupDir = process.env.BACKUP_DIR || 
                        process.env.RAILWAY_VOLUME_MOUNT_PATH || 
                        path.join(__dirname, 'backups');
        
        // Ensure backup directory exists
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
        
        // Maximum backups to keep (default: 30)
        this.maxBackups = parseInt(process.env.MAX_BACKUPS || '30');
    }
    
    /**
     * Create a full system backup
     * @returns {Promise<Object>} Backup metadata
     */
    async createBackup() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupId = `backup-${timestamp}`;
        const backupPath = path.join(this.backupDir, `${backupId}.tar.gz`);
        const tempDir = path.join(this.backupDir, backupId);
        
        try {
            // Create temporary directory for backup contents
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            
            console.log(`📦 Creating backup: ${backupId}`);
            
            // 1. Backup database
            const dbBackupPath = path.join(tempDir, 'database.sql');
            await this.backupDatabase(dbBackupPath);
            
            // 2. Backup files
            const filesDir = path.join(tempDir, 'files');
            if (!fs.existsSync(filesDir)) {
                fs.mkdirSync(filesDir, { recursive: true });
            }
            await this.backupFiles(filesDir);
            
            // 3. Create metadata
            const metadata = {
                id: backupId,
                timestamp: new Date().toISOString(),
                version: require('./package.json').version,
                database_type: isPostgreSQL ? 'PostgreSQL' : 'SQLite',
                created_by: 'system'
            };
            
            fs.writeFileSync(
                path.join(tempDir, 'metadata.json'),
                JSON.stringify(metadata, null, 2)
            );
            
            // 4. Create compressed archive
            await this.createArchive(tempDir, backupPath);
            
            // 5. Clean up temp directory
            this.deleteDirectory(tempDir);
            
            // 6. Get file size
            const stats = fs.statSync(backupPath);
            const fileSize = stats.size;
            
            // 7. Clean up old backups
            await this.cleanupOldBackups();
            
            console.log(`✅ Backup created: ${backupId} (${this.formatFileSize(fileSize)})`);
            
            return {
                ...metadata,
                file_path: backupPath,
                file_name: `${backupId}.tar.gz`,
                file_size: fileSize,
                file_size_formatted: this.formatFileSize(fileSize)
            };
        } catch (error) {
            // Clean up on error
            if (fs.existsSync(tempDir)) {
                this.deleteDirectory(tempDir);
            }
            if (fs.existsSync(backupPath)) {
                fs.unlinkSync(backupPath);
            }
            console.error('❌ Backup creation failed:', error);
            throw error;
        }
    }
    
    /**
     * Backup database to SQL file
     */
    async backupDatabase(outputPath) {
        if (isPostgreSQL) {
            await this.backupPostgreSQL(outputPath);
        } else {
            await this.backupSQLite(outputPath);
        }
    }
    
    /**
     * Backup PostgreSQL database
     */
    async backupPostgreSQL(outputPath) {
        try {
            // Get all tables from both schemas
            const tables = await this.getAllPostgreSQLTables();
            
            const sqlStatements = [];
            
            // Export schema and data for each table
            for (const table of tables) {
                try {
                    // Get table schema
                    const schemaResult = await pool.query(`
                        SELECT column_name, data_type, character_maximum_length, 
                               is_nullable, column_default
                        FROM information_schema.columns
                        WHERE table_name = $1
                        ORDER BY ordinal_position
                    `, [table]);
                    
                    // Get table data
                    const dataResult = await pool.query(`SELECT * FROM ${table}`);
                    
                    // Generate CREATE TABLE statement
                    sqlStatements.push(`\n-- Table: ${table}`);
                    sqlStatements.push(`DROP TABLE IF EXISTS ${table} CASCADE;`);
                    
                    const columns = schemaResult.rows.map(col => {
                        let def = col.column_name;
                        if (col.data_type === 'character varying') {
                            def += ` VARCHAR(${col.character_maximum_length})`;
                        } else if (col.data_type === 'integer') {
                            def += ' INTEGER';
                        } else if (col.data_type === 'bigint') {
                            def += ' BIGINT';
                        } else if (col.data_type === 'boolean') {
                            def += ' BOOLEAN';
                        } else if (col.data_type === 'numeric') {
                            def += ' NUMERIC';
                        } else if (col.data_type === 'text') {
                            def += ' TEXT';
                        } else if (col.data_type === 'timestamp without time zone') {
                            def += ' TIMESTAMP';
                        } else if (col.data_type === 'jsonb') {
                            def += ' JSONB';
                        } else {
                            def += ` ${col.data_type.toUpperCase()}`;
                        }
                        
                        if (col.is_nullable === 'NO') {
                            def += ' NOT NULL';
                        }
                        
                        if (col.column_default) {
                            def += ` DEFAULT ${col.column_default}`;
                        }
                        
                        return def;
                    });
                    
                    sqlStatements.push(`CREATE TABLE ${table} (${columns.join(', ')});`);
                    
                    // Insert data
                    if (dataResult.rows.length > 0) {
                        const columnNames = Object.keys(dataResult.rows[0]).join(', ');
                        for (const row of dataResult.rows) {
                            const values = Object.values(row).map(val => {
                                if (val === null) return 'NULL';
                                if (typeof val === 'string') {
                                    return `'${val.replace(/'/g, "''")}'`;
                                }
                                if (typeof val === 'boolean') {
                                    return val ? 'TRUE' : 'FALSE';
                                }
                                if (val instanceof Date) {
                                    return `'${val.toISOString()}'`;
                                }
                                return val;
                            }).join(', ');
                            sqlStatements.push(`INSERT INTO ${table} (${columnNames}) VALUES (${values});`);
                        }
                    }
                } catch (tableError) {
                    console.warn(`⚠️ Could not backup table ${table}:`, tableError.message);
                }
            }
            
            // Write SQL to file
            const sqlContent = sqlStatements.join('\n');
            fs.writeFileSync(outputPath, sqlContent, 'utf8');
            
        } catch (error) {
            console.error('❌ PostgreSQL backup failed:', error);
            throw error;
        }
    }
    
    /**
     * Get all PostgreSQL tables
     */
    async getAllPostgreSQLTables() {
        const result = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
            ORDER BY table_name
        `);
        return result.rows.map(row => row.table_name);
    }
    
    /**
     * Backup SQLite database
     */
    async backupSQLite(outputPath) {
        // SQLite backup would require access to the database file
        // For now, we'll create a placeholder
        fs.writeFileSync(outputPath, '-- SQLite backup (file-based, copy database file directly)\n', 'utf8');
    }
    
    /**
     * Backup configuration and system files
     */
    async backupFiles(filesDir) {
        try {
            // Backup .env file (sanitized - remove sensitive keys)
            if (fs.existsSync('.env')) {
                const envContent = fs.readFileSync('.env', 'utf8');
                const sanitized = this.sanitizeEnvFile(envContent);
                fs.writeFileSync(path.join(filesDir, '.env.sanitized'), sanitized);
            }
            
            // Backup package.json
            if (fs.existsSync('package.json')) {
                fs.copyFileSync('package.json', path.join(filesDir, 'package.json'));
            }
            
            // Backup railway.json if exists
            if (fs.existsSync('railway.json')) {
                fs.copyFileSync('railway.json', path.join(filesDir, 'railway.json'));
            }
            
            // Backup nixpacks.toml if exists
            if (fs.existsSync('nixpacks.toml')) {
                fs.copyFileSync('nixpacks.toml', path.join(filesDir, 'nixpacks.toml'));
            }
            
        } catch (error) {
            console.warn('⚠️ File backup warning:', error.message);
            // Don't throw - file backup is optional
        }
    }
    
    /**
     * Sanitize .env file by removing sensitive values
     */
    sanitizeEnvFile(content) {
        const sensitiveKeys = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN', 'AUTH'];
        const lines = content.split('\n');
        
        return lines.map(line => {
            if (line.trim().startsWith('#')) return line;
            
            const match = line.match(/^([^=]+)=(.+)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                
                // Check if key contains sensitive words
                if (sensitiveKeys.some(sensitive => key.toUpperCase().includes(sensitive))) {
                    return `${key}=***REDACTED***`;
                }
            }
            
            return line;
        }).join('\n');
    }
    
    /**
     * Create compressed tar.gz archive
     */
    async createArchive(sourceDir, outputPath) {
        return new Promise((resolve, reject) => {
            // Try to use tar command if available (Unix/Linux)
            const isWindows = process.platform === 'win32';
            
            if (isWindows) {
                // On Windows, use fallback method
                this.createArchiveFallback(sourceDir, outputPath)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            
            // Use tar command on Unix/Linux
            const command = `cd "${sourceDir}" && tar -czf "${outputPath}" . 2>&1`;
            
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    // Fallback: create a simple directory structure
                    console.warn('⚠️ tar command failed, using fallback method');
                    this.createArchiveFallback(sourceDir, outputPath)
                        .then(resolve)
                        .catch(reject);
                } else {
                    resolve();
                }
            });
        });
    }
    
    /**
     * Fallback archive creation (simple directory copy)
     * For Railway/Windows compatibility where tar might not be available
     */
    async createArchiveFallback(sourceDir, outputPath) {
        // For compatibility, we'll create a directory structure
        // The restore process will handle both tar.gz and directory formats
        const archiveDir = outputPath.replace('.tar.gz', '');
        if (fs.existsSync(archiveDir)) {
            this.deleteDirectory(archiveDir);
        }
        fs.mkdirSync(archiveDir, { recursive: true });
        
        // Copy all files recursively
        this.copyDirectory(sourceDir, archiveDir);
        
        // Create a marker file to indicate this is a directory backup
        fs.writeFileSync(path.join(archiveDir, '.backup-format'), 'directory');
        
        // Also create a note about the format
        fs.writeFileSync(
            path.join(archiveDir, 'README.txt'),
            'This is a directory-format backup.\nThe restore process will handle this format automatically.'
        );
    }
    
    /**
     * Copy directory recursively
     */
    copyDirectory(src, dest) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        
        const entries = fs.readdirSync(src, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                this.copyDirectory(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }
    
    /**
     * Delete directory recursively
     */
    deleteDirectory(dirPath) {
        if (fs.existsSync(dirPath)) {
            fs.readdirSync(dirPath).forEach(file => {
                const curPath = path.join(dirPath, file);
                if (fs.lstatSync(curPath).isDirectory()) {
                    this.deleteDirectory(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            });
            fs.rmdirSync(dirPath);
        }
    }
    
    /**
     * List all backups
     */
    async listBackups() {
        try {
            const files = fs.readdirSync(this.backupDir);
            const backups = [];
            const processedIds = new Set();
            
            for (const file of files) {
                const filePath = path.join(this.backupDir, file);
                let stats;
                
                try {
                    stats = fs.statSync(filePath);
                } catch (e) {
                    continue; // Skip if can't stat
                }
                
                // Handle .tar.gz files
                if (file.endsWith('.tar.gz') && file.startsWith('backup-')) {
                    const backupId = file.replace('.tar.gz', '');
                    if (processedIds.has(backupId)) continue;
                    processedIds.add(backupId);
                    
                    // Try to read metadata from extracted directory if available
                    let metadata = null;
                    const metadataDir = path.join(this.backupDir, backupId);
                    if (fs.existsSync(metadataDir)) {
                        try {
                            const metadataPath = path.join(metadataDir, 'metadata.json');
                            if (fs.existsSync(metadataPath)) {
                                metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                            }
                        } catch (e) {
                            // Metadata not available
                        }
                    }
                    
                    backups.push({
                        id: backupId,
                        file_name: file,
                        file_path: filePath,
                        file_size: stats.size,
                        file_size_formatted: this.formatFileSize(stats.size),
                        created_at: metadata?.timestamp || stats.birthtime.toISOString(),
                        timestamp: metadata?.timestamp || stats.birthtime.toISOString()
                    });
                }
                // Handle directory-format backups
                else if (stats.isDirectory() && file.startsWith('backup-')) {
                    const backupId = file;
                    if (processedIds.has(backupId)) continue;
                    processedIds.add(backupId);
                    
                    // Calculate directory size
                    let dirSize = 0;
                    try {
                        const calculateSize = (dir) => {
                            const files = fs.readdirSync(dir);
                            for (const f of files) {
                                const filePath = path.join(dir, f);
                                const fileStat = fs.statSync(filePath);
                                if (fileStat.isDirectory()) {
                                    calculateSize(filePath);
                                } else {
                                    dirSize += fileStat.size;
                                }
                            }
                        };
                        calculateSize(filePath);
                    } catch (e) {
                        // Could not calculate size
                    }
                    
                    // Try to read metadata
                    let metadata = null;
                    try {
                        const metadataPath = path.join(filePath, 'metadata.json');
                        if (fs.existsSync(metadataPath)) {
                            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                        }
                    } catch (e) {
                        // Metadata not available
                    }
                    
                    backups.push({
                        id: backupId,
                        file_name: `${backupId}/ (directory)`,
                        file_path: filePath,
                        file_size: dirSize,
                        file_size_formatted: this.formatFileSize(dirSize),
                        created_at: metadata?.timestamp || stats.birthtime.toISOString(),
                        timestamp: metadata?.timestamp || stats.birthtime.toISOString()
                    });
                }
            }
            
            // Sort by date (newest first)
            backups.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            
            return backups;
        } catch (error) {
            console.error('❌ Error listing backups:', error);
            return [];
        }
    }
    
    /**
     * Get backup file path
     */
    getBackupPath(backupId) {
        // Try .tar.gz first
        let backupPath = path.join(this.backupDir, `${backupId}.tar.gz`);
        if (fs.existsSync(backupPath)) {
            return backupPath;
        }
        
        // Try directory format (without .tar.gz extension)
        backupPath = path.join(this.backupDir, backupId);
        if (fs.existsSync(backupPath) && fs.lstatSync(backupPath).isDirectory()) {
            return backupPath;
        }
        
        // Try with backup- prefix if backupId doesn't have it
        if (!backupId.startsWith('backup-')) {
            backupPath = path.join(this.backupDir, `backup-${backupId}.tar.gz`);
            if (fs.existsSync(backupPath)) {
                return backupPath;
            }
            
            backupPath = path.join(this.backupDir, `backup-${backupId}`);
            if (fs.existsSync(backupPath) && fs.lstatSync(backupPath).isDirectory()) {
                return backupPath;
            }
        }
        
        throw new Error(`Backup not found: ${backupId}`);
    }
    
    /**
     * Restore from backup
     */
    async restoreBackup(backupId) {
        console.log(`🔄 Restoring backup: ${backupId}`);
        
        const backupPath = this.getBackupPath(backupId);
        const isDirectory = fs.lstatSync(backupPath).isDirectory();
        
        let tempDir;
        
        try {
            // Extract if needed
            if (!isDirectory) {
                tempDir = path.join(this.backupDir, `restore-${Date.now()}`);
                fs.mkdirSync(tempDir, { recursive: true });
                
                // Extract tar.gz
                await new Promise((resolve, reject) => {
                    const command = `cd "${tempDir}" && tar -xzf "${backupPath}" 2>&1`;
                    exec(command, (error, stdout, stderr) => {
                        if (error) {
                            // If tar fails, the backup might be in directory format
                            console.warn('⚠️ Could not extract tar.gz, trying directory format');
                            resolve();
                        } else {
                            resolve();
                        }
                    });
                });
            } else {
                tempDir = backupPath;
            }
            
            // Read metadata
            const metadataPath = path.join(tempDir, 'metadata.json');
            if (!fs.existsSync(metadataPath)) {
                throw new Error('Backup metadata not found');
            }
            
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            
            // Create safety backup before restore
            console.log('📦 Creating safety backup before restore...');
            const safetyBackup = await this.createBackup();
            console.log(`✅ Safety backup created: ${safetyBackup.id}`);
            
            // Restore database
            const dbBackupPath = path.join(tempDir, 'database.sql');
            if (fs.existsSync(dbBackupPath)) {
                await this.restoreDatabase(dbBackupPath);
            }
            
            // Restore files (optional - be careful with .env)
            const filesDir = path.join(tempDir, 'files');
            if (fs.existsSync(filesDir)) {
                console.log('⚠️ File restore skipped (manual restore recommended for .env)');
                // await this.restoreFiles(filesDir);
            }
            
            // Clean up temp directory if we created it
            if (!isDirectory && tempDir && fs.existsSync(tempDir)) {
                this.deleteDirectory(tempDir);
            }
            
            console.log(`✅ Restore completed: ${backupId}`);
            
            return {
                success: true,
                backup_id: backupId,
                safety_backup_id: safetyBackup.id,
                restored_at: new Date().toISOString()
            };
            
        } catch (error) {
            console.error('❌ Restore failed:', error);
            throw error;
        }
    }
    
    /**
     * Restore database from SQL file
     */
    async restoreDatabase(sqlPath) {
        const sqlContent = fs.readFileSync(sqlPath, 'utf8');
        
        if (isPostgreSQL) {
            // Execute SQL statements
            const statements = sqlContent.split(';').filter(s => s.trim());
            
            for (const statement of statements) {
                if (statement.trim()) {
                    try {
                        await pool.query(statement);
                    } catch (error) {
                        console.warn('⚠️ SQL statement failed:', error.message);
                        // Continue with other statements
                    }
                }
            }
        } else {
            console.warn('⚠️ SQLite restore not fully implemented');
        }
    }
    
    /**
     * Delete backup
     */
    async deleteBackup(backupId) {
        const backupPath = this.getBackupPath(backupId);
        
        if (fs.lstatSync(backupPath).isDirectory()) {
            this.deleteDirectory(backupPath);
        } else {
            fs.unlinkSync(backupPath);
        }
        
        console.log(`🗑️ Backup deleted: ${backupId}`);
    }
    
    /**
     * Clean up old backups (keep only maxBackups)
     */
    async cleanupOldBackups() {
        const backups = await this.listBackups();
        
        if (backups.length > this.maxBackups) {
            const toDelete = backups.slice(this.maxBackups);
            
            for (const backup of toDelete) {
                try {
                    await this.deleteBackup(backup.id);
                } catch (error) {
                    console.warn(`⚠️ Could not delete backup ${backup.id}:`, error.message);
                }
            }
            
            console.log(`🧹 Cleaned up ${toDelete.length} old backup(s)`);
        }
    }
    
    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
}

module.exports = BackupService;

