import { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";

/**
 * Middleware to ensure incoming hardware requests originate from authorized ESP32 terminals
 */
export function hardwareAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const apiKey =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace("Bearer ", "");

  if (!apiKey || apiKey !== env.HARDWARE_API_KEY) {
    res.status(401).json({
      success: false,
      code: "UNAUTHORIZED_TERMINAL",
      message: "Access denied: Invalid or missing hardware API key.",
    });
    return;
  }

  next();
}
