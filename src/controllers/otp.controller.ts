import { Request, Response } from 'express';
import { z } from 'zod';
import { otpService } from '../services/otp.service.js';

const requestOtpSchema = z.object({
  identifier: z.string().min(1, 'Student ID or institutional email is required'),
});

export class OtpController {
  /**
   * POST /api/v1/otp/request
   * Student web fallback endpoint to generate 60-second time-decaying OTP
   */
  async requestOtp(req: Request, res: Response): Promise<void> {
    try {
      const parsed = requestOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid request payload',
        });
        return;
      }

      const result = await otpService.requestStudentOtp(parsed.data.identifier);

      res.status(200).json({
        success: true,
        message: 'One-Time PIN generated successfully. Enter on classroom terminal keypad within 60 seconds.',
        data: result,
      });
    } catch (err: any) {
      console.warn('⚠️ OTP request failed:', err.message);
      res.status(400).json({
        success: false,
        message: err.message || 'Failed to generate OTP',
      });
    }
  }
}

export const otpController = new OtpController();
export default otpController;
