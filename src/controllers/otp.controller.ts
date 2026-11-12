import { Response } from 'express';
import { z } from 'zod';
import { otpService } from '../services/otp.service.js';
import { AuthRequest } from '../middlewares/auth.middleware.js';

const requestOtpSchema = z
  .object({
    identifier: z.string().optional(),
    studentId: z.string().optional(),
  })
  .refine((data) => data.identifier || data.studentId, {
    message: 'Student ID or institutional email is required',
  });

export class OtpController {
  /**
   * POST /api/v1/otp/request
   * Student web fallback endpoint to generate 60-second time-decaying OTP
   */
  async requestOtp(req: AuthRequest, res: Response): Promise<void> {
    try {
      let identifier: string | undefined;

      const parsed = requestOtpSchema.safeParse(req.body);
      if (parsed.success) {
        identifier = parsed.data.identifier || parsed.data.studentId;
      } else if (req.user?.email) {
        identifier = req.user.email;
      } else {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid request payload',
        });
        return;
      }

      const result = await otpService.requestStudentOtp(identifier!);

      res.status(200).json({
        success: true,
        message: 'One-Time PIN generated successfully. Enter on classroom terminal keypad within 60 seconds.',
        otp: result.otp,
        expiresIn: result.expiresInSeconds,
        expiresAt: result.expiresAt,
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
