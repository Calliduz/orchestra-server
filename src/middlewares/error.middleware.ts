import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    return next(err);
  }

  console.error('💥 Unhandled Exception:', err);

  const statusCode = Number(err.statusCode || err.status) || (res.statusCode >= 400 ? res.statusCode : 500);
  const message = (err && typeof err === 'object' && err.message)
    ? err.message
    : (typeof err === 'string' ? err : 'Internal Server Error');

  res.status(statusCode).json({
    success: false,
    message,
    ...(err.code ? { code: err.code } : {}),
    ...(process.env.NODE_ENV === 'development' && err.stack ? { stack: err.stack } : {}),
  });
}
