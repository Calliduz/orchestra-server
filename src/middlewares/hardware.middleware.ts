import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AuthRequest } from "./auth.middleware.js";

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

/**
 * Middleware that allows either a valid hardware API key or a valid JWT session token
 */
export function hardwareOrJwtAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === env.HARDWARE_API_KEY) {
    return next();
  }

  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (token === env.HARDWARE_API_KEY) {
      return next();
    }
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as any;
      req.user = decoded;
      return next();
    } catch {
      res.status(403).json({
        success: false,
        message: "Invalid or expired session token.",
      });
      return;
    }
  }

  res.status(401).json({
    success: false,
    code: "UNAUTHORIZED",
    message: "Authentication required. Valid hardware API key or session token required.",
  });
}
