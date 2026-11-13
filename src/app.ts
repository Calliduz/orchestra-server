import express from 'express';
import cors from 'cors';
import routes from './routes/index.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { isOriginAllowed } from './config/cors.js';
import prisma from './config/prisma.js';

export const app = express();

// Middlewares
app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        const corsError = new Error(`Origin ${origin} not allowed by ORCHESTRA CORS policy`);
        (corsError as any).statusCode = 403;
        callback(corsError);
      }
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging in development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });
}

// Health check endpoint (direct root access)
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: 'ONLINE',
      database: 'connected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'ERROR',
      database: 'disconnected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      error: error?.message || 'Database connection failure',
    });
  }
});

// API Routes
app.use('/api/v1', routes);

// 404 Handler for unmatched routes to ensure consistent JSON error response
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl || req.url}`,
  });
});

// Global Error Handler
app.use(errorHandler);

export default app;
