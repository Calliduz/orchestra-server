import { SessionStatus } from '@prisma/client';
import prisma from '../config/prisma.js';
import { sessionService } from './session.service.js';

export class WatchdogService {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Starts background watchdog interval runner
   * Defaults to sweeping every 5 minutes (300,000 ms)
   */
  start(intervalMs: number = 5 * 60 * 1000): void {
    if (this.timer) {
      console.log('⚠️ [WATCHDOG] Watchdog runner is already active.');
      return;
    }

    console.log(`⏱️ [WATCHDOG] Starting session auto-close watchdog (Interval: ${intervalMs / 1000}s)`);
    this.timer = setInterval(() => {
      this.checkAndAutoCloseSessions().catch((err) => {
        console.error('❌ [WATCHDOG ERROR] Error during auto-close sweep:', err);
      });
    }, intervalMs);

    // Run an initial sweep 10 seconds after boot to catch any stale sessions
    this.initialTimer = setTimeout(() => {
      this.checkAndAutoCloseSessions().catch((err) => {
        console.error('❌ [WATCHDOG ERROR] Error during initial auto-close sweep:', err);
      });
      this.initialTimer = null;
    }, 10000);
  }

  /**
   * Stops the background watchdog interval runner
   */
  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('🛑 [WATCHDOG] Stopped session auto-close watchdog runner.');
    }
  }

  /**
   * Sweeps all currently OPEN sessions and auto-finalizes any that have:
   * 1. Exceeded scheduled end time + 15 minutes grace window.
   * 2. Inactive for 90 minutes (no attendance scans or taps).
   */
  async checkAndAutoCloseSessions(): Promise<number> {
    if (this.isRunning) {
      return 0;
    }
    this.isRunning = true;

    try {
      const openSessions = await prisma.session.findMany({
        where: { status: SessionStatus.OPEN },
        include: {
          section: true,
          faculty: true,
          attendanceLogs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      if (openSessions.length === 0) {
        return 0;
      }

      const now = new Date();
      let closedCount = 0;

      for (const session of openSessions) {
        let shouldClose = false;
        let reason = '';

        // Check 1: Exceeded scheduleEndTime + 15 minutes
        if (session.section.scheduleEndTime) {
          const parts = session.section.scheduleEndTime.split(':').map(Number);
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            const schedEnd = new Date(session.startTime);
            schedEnd.setHours(parts[0], parts[1], 0, 0);

            // If scheduled end calculated on session start day is prior to start time, advance by 1 day
            if (schedEnd.getTime() < session.startTime.getTime()) {
              schedEnd.setDate(schedEnd.getDate() + 1);
            }

            const expiryTime = new Date(schedEnd.getTime() + 15 * 60 * 1000); // +15 min grace period
            if (now.getTime() > expiryTime.getTime()) {
              shouldClose = true;
              reason = `Schedule ended at ${session.section.scheduleEndTime} (+15m grace window passed)`;
            }
          }
        }

        // Check 2: Inactivity over 90 minutes
        if (!shouldClose) {
          const lastLog = session.attendanceLogs[0];
          const lastActivity = lastLog
            ? (lastLog.tapTimestamp || lastLog.createdAt)
            : session.startTime;

          const inactivityMins = (now.getTime() - new Date(lastActivity).getTime()) / (1000 * 60);

          if (inactivityMins >= 90) {
            shouldClose = true;
            reason = `Inactivity timeout: ${Math.round(inactivityMins)}m since last activity`;
          }
        }

        if (shouldClose) {
          console.log(`🕒 [WATCHDOG AUTO-CLOSE] Session ${session.id} (${session.section.sectionCode}) auto-closing: ${reason}`);
          try {
            await sessionService.closeSession(session.id, true);
            closedCount++;
          } catch (closeErr) {
            console.error(`❌ [WATCHDOG] Failed to auto-close session ${session.id}:`, closeErr);
          }
        }
      }

      if (closedCount > 0) {
        console.log(`✅ [WATCHDOG] Auto-closed ${closedCount} expired or abandoned session(s).`);
      }

      return closedCount;
    } finally {
      this.isRunning = false;
    }
  }
}

export const watchdogService = new WatchdogService();
export default watchdogService;
