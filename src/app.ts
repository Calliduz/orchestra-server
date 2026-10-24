import express from 'express';
import cors from 'cors';
import routes from './routes/index.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { env } from './config/env.js';

export const app = express();

// Middlewares
app.use(
  cors({
    origin: [env.CLIENT_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'],
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

// API Routes
app.use('/api/v1', routes);

// Global Error Handler
app.use(errorHandler);

export default app;
