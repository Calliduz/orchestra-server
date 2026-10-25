import rateLimit from 'express-rate-limit';

/**
 * Rate Limiter for physical 4x4 Keypad OTP verification.
 * Disallows rapid automated brute-force attempts from rogue clients or compromised terminals.
 * Max 5 submissions per 10 seconds per IP/terminal.
 */
export const keypadOtpLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 5, // 5 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'SECURITY INTERLOCK: Too many keypad OTP verification attempts. Please wait 10 seconds.',
  },
});

/**
 * Rate Limiter for student 60-second OTP generation requests.
 * Prevents flood generation and token exhaustion.
 * Max 3 requests per 60 seconds per IP.
 */
export const otpRequestLimiter = rateLimit({
  windowMs: 60 * 1000, // 60 seconds
  max: 3, // 3 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'RATE LIMIT: Too many OTP generation requests. You can only request a new PIN after your current 60-second window.',
  },
});

/**
 * Rate Limiter for hardware RFID card taps.
 * Protects server telemetry against replay loops or misconfigured hardware loops.
 * Max 60 taps per 30 seconds per terminal.
 */
export const hardwareTapLimiter = rateLimit({
  windowMs: 30 * 1000, // 30 seconds
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'HARDWARE THROTTLE: Ingress tap rate exceeded terminal throughput capacity.',
  },
});
