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
  code: z.string().min(6, 'OTP must be 6 digits').max(6, 'OTP must be 6 digits'),
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

      const { terminalId, code } = parsed.data;
      const result = await otpService.verifyKeypadOtp(terminalId, code);

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
   */
  async getTerminalStatus(req: Request, res: Response): Promise<void> {
    try {
      const terminalId = req.params.terminalId as string;
      const sessionData = await sessionService.getActiveSession(terminalId);

      res.status(200).json({
        success: true,
        terminalId,
        isLocked: sessionData.isLocked,
        status: sessionData.status,
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
}

export const hardwareController = new HardwareController();
export default hardwareController;
