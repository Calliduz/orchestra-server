import { Request, Response } from 'express';
import { z } from 'zod';
import { hardwareService } from '../services/hardware.service.js';
import { otpService } from '../services/otp.service.js';
import { sessionService } from '../services/session.service.js';

const tapSchema = z.object({
  terminalId: z.string().min(1, 'Terminal ID is required'),
  rfidUid: z.string().min(1, 'RFID UID is required'),
});

const otpSchema = z.object({
  terminalId: z.string().min(1, 'Terminal ID is required'),
  code: z.string().min(6, 'OTP must be 6 digits').max(6, 'OTP must be 6 digits').optional(),
  otp: z.string().min(6, 'OTP must be 6 digits').max(6, 'OTP must be 6 digits').optional(),
}).refine((data) => data.code || data.otp, {
  message: 'OTP PIN (code or otp) is required',
});

export class HardwareController {
  /**
   * POST /api/v1/hardware/tap
   * Main RFID tap ingest from ESP32 terminal
   */
  async handleCardTap(req: Request, res: Response): Promise<void> {
    try {
      const parsed = tapSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          code: 'INVALID_PAYLOAD',
          message: parsed.error.issues[0]?.message || 'Invalid tap payload',
        });
        return;
      }

      const { terminalId, rfidUid } = parsed.data;
      const result = await hardwareService.processCardTap(terminalId, rfidUid);

      res.status(result.statusCode).json({
        success: result.success,
        code: result.code,
        message: result.message,
        data: result.data,
      });
    } catch (err: any) {
      console.error('❌ Error handling hardware card tap:', err);
      res.status(500).json({
        success: false,
        code: 'ERROR',
        message: err.message || 'Internal hardware processing error',
      });
    }
  }

  /**
   * POST /api/v1/hardware/otp
   * 6-Digit PIN submission from ESP32 4x4 matrix keypad
   */
  async handleKeypadOtp(req: Request, res: Response): Promise<void> {
    try {
      const parsed = otpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          code: 'INVALID_PAYLOAD',
          message: parsed.error.issues[0]?.message || 'Invalid OTP payload',
        });
        return;
      }

      const { terminalId } = parsed.data;
      const pin = (parsed.data.code || parsed.data.otp)!;
      const result = await otpService.verifyKeypadOtp(terminalId, pin);

      res.status(result.statusCode).json({
        success: result.success,
        code: result.code,
        message: result.message,
        data: result.data,
      });
    } catch (err: any) {
      console.error('❌ Error handling keypad OTP:', err);
      res.status(500).json({
        success: false,
        code: 'ERROR',
        message: err.message || 'Internal keypad OTP processing error',
      });
    }
  }

  /**
   * GET /api/v1/hardware/status/:terminalId
   * Quick status ping for ESP32 OLED state machine
   * Includes local copy of authorized faculty UIDs for offline session unlock/lock
   */
  async getTerminalStatus(req: Request, res: Response): Promise<void> {
    try {
      const terminalId = req.params.terminalId as string;
      const sessionData = await sessionService.getActiveSession(terminalId);
      const enrollment = hardwareService.getEnrollmentSession(terminalId);
      const authorizedFaculty = await hardwareService.getAuthorizedFaculty(terminalId);

      res.status(200).json({
        success: true,
        terminalId,
        isLocked: sessionData.isLocked,
        status: sessionData.status,
        enrollment,
        authorizedFaculty, // Local copy of professor/admin UIDs for offline caching
        offlineSyncSupported: true,
        session: sessionData.session
          ? {
              id: sessionData.session.id,
              sectionCode: sessionData.session.sectionCode,
              courseName: sessionData.session.courseName,
              facultyName: sessionData.session.facultyName,
              startTime: sessionData.session.startTime,
            }
          : null,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err.message || 'Error fetching terminal status',
      });
    }
  }

  /**
   * POST /api/v1/hardware/offline-sync
   * Ingests batch of offline attendance logs recorded on ESP32 during network outage
   */
  async handleOfflineSync(req: Request, res: Response): Promise<void> {
    try {
      const { terminalId = 'TERM-CL304', sessionAction = 'CONTINUE', facultyUid, records } = req.body;
      const result = await hardwareService.processOfflineSync(terminalId, {
        sessionAction,
        facultyUid,
        records: Array.isArray(records) ? records : [],
      });
      res.status(result.statusCode || 200).json(result);
    } catch (err: any) {
      console.error('Error in handleOfflineSync:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Internal server error processing offline sync',
      });
    }
  }

  /**
   * POST /api/v1/hardware/enrollment/start
   * Start live admin scanning session for new student or faculty
   */
  startEnrollment(req: Request, res: Response): void {
    const { terminalId = 'TERM-CL304', targetRole = 'STUDENT', targetName } = req.body;
    const session = hardwareService.startEnrollmentSession(terminalId, targetRole, targetName);
    res.status(200).json({
      success: true,
      message: `Enrollment mode armed on ${terminalId} for ${targetRole}`,
      data: session,
    });
  }

  /**
   * POST /api/v1/hardware/enrollment/stop
   * Stop live admin scanning session
   */
  stopEnrollment(req: Request, res: Response): void {
    const { terminalId } = req.body;
    hardwareService.stopEnrollmentSession(terminalId);
    res.status(200).json({
      success: true,
      message: 'Enrollment mode disarmed',
    });
  }

  /**
   * GET /api/v1/hardware/enrollment/status/:terminalId?
   * Get active enrollment session state
   */
  getEnrollmentStatus(req: Request, res: Response): void {
    const terminalId = req.params.terminalId as string;
    const status = hardwareService.getEnrollmentSession(terminalId);
    res.status(200).json({
      success: true,
      data: status,
    });
  }

  /**
   * GET /api/v1/hardware/last-scanned
   * Returns the most recently scanned RFID tag for live web registration
   */
  getLastScanned(req: Request, res: Response): void {
    const last = hardwareService.getLastScanned();
    res.status(200).json({
      success: true,
      data: last,
    });
  }
}

export const hardwareController = new HardwareController();
export default hardwareController;
