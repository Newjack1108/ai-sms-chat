// Backup Scheduler for Automated Backups
const BackupService = require('./backup-service');

class BackupScheduler {
    constructor() {
        this.backupService = new BackupService();
        this.scheduleInterval = null;
        this.isRunning = false;
        this.schedule = {
            enabled: false,
            frequency: 'daily', // daily, weekly
            time: '02:00', // HH:MM format
            day_of_week: 0 // 0 = Sunday (for weekly)
        };
    }
    
    /**
     * Start the scheduler
     */
    start() {
        if (this.isRunning) {
            console.log('⚠️ Backup scheduler is already running');
            return;
        }
        
        this.isRunning = true;
        console.log('🕐 Backup scheduler started');
        
        // Check schedule every minute
        this.scheduleInterval = setInterval(() => {
            this.checkAndRunBackup();
        }, 60000); // Check every minute
        
        // Also check immediately
        this.checkAndRunBackup();
    }
    
    /**
     * Stop the scheduler
     */
    stop() {
        if (this.scheduleInterval) {
            clearInterval(this.scheduleInterval);
            this.scheduleInterval = null;
        }
        this.isRunning = false;
        console.log('🛑 Backup scheduler stopped');
    }
    
    /**
     * Update schedule configuration
     */
    updateSchedule(schedule) {
        this.schedule = {
            enabled: schedule.enabled || false,
            frequency: schedule.frequency || 'daily',
            time: schedule.time || '02:00',
            day_of_week: schedule.day_of_week || 0
        };
        
        console.log('📅 Backup schedule updated:', this.schedule);
    }
    
    /**
     * Check if it's time to run a backup
     */
    checkAndRunBackup() {
        if (!this.schedule.enabled) {
            return;
        }
        
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        const currentDay = now.getDay(); // 0 = Sunday
        
        // Parse scheduled time
        const [scheduledHour, scheduledMinute] = this.schedule.time.split(':').map(Number);
        
        // Check if current time matches scheduled time (within 1 minute window)
        const timeMatches = currentHour === scheduledHour && 
                           currentMinute >= scheduledMinute && 
                           currentMinute < scheduledMinute + 1;
        
        if (!timeMatches) {
            return;
        }
        
        // Check frequency
        if (this.schedule.frequency === 'daily') {
            // Daily backup - run if time matches
            this.runScheduledBackup();
        } else if (this.schedule.frequency === 'weekly') {
            // Weekly backup - run if time matches AND day matches
            if (currentDay === this.schedule.day_of_week) {
                this.runScheduledBackup();
            }
        }
    }
    
    /**
     * Run a scheduled backup
     */
    async runScheduledBackup() {
        // Prevent multiple simultaneous backups
        if (this.backupInProgress) {
            console.log('⏳ Backup already in progress, skipping scheduled backup');
            return;
        }
        
        this.backupInProgress = true;
        
        try {
            console.log('📦 Running scheduled backup...');
            const backup = await this.backupService.createBackup();
            console.log(`✅ Scheduled backup completed: ${backup.id}`);
        } catch (error) {
            console.error('❌ Scheduled backup failed:', error);
        } finally {
            // Reset flag after a delay to prevent immediate re-triggering
            setTimeout(() => {
                this.backupInProgress = false;
            }, 60000); // Wait 1 minute before allowing another backup
        }
    }
    
    /**
     * Get current schedule
     */
    getSchedule() {
        return { ...this.schedule };
    }
}

// Singleton instance
let schedulerInstance = null;

function getScheduler() {
    if (!schedulerInstance) {
        schedulerInstance = new BackupScheduler();
    }
    return schedulerInstance;
}

module.exports = { BackupScheduler, getScheduler };



