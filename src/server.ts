import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { initializeSocket } from './sockets/telemetry.socket.js';
import prisma from './config/prisma.js';
import { watchdogService } from './services/watchdog.service.js';

const server = http.createServer(app);

// Robust GET /health endpoint verifying database connectivity via prisma.$queryRaw
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

// Initialize Socket.io Telemetry Server
initializeSocket(server);

// Start HTTP + WebSocket Server
server.listen(env.PORT, () => {
  console.log('\n======================================================');
  console.log('🎻 ORCHESTRA BACKEND SERVER RUNNING');
  console.log('======================================================');
  console.log(`📡 Port:               ${env.PORT}`);
  console.log(`🌐 Base URL:           http://localhost:${env.PORT}/api/v1`);
  console.log(`⚡ WebSocket Status:   ACTIVE (Socket.io Telemetry Engine)`);
  console.log(`🛡️ Hardware API Key:   ${env.HARDWARE_API_KEY}`);
  console.log(`🏢 Neon DB URL:        Connected via AWS ap-southeast-1`);
  console.log('======================================================\n');

  // Start background watchdog for auto-closing expired/abandoned sessions
  watchdogService.start();
});

// Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received. Closing HTTP server and database pool...');
  watchdogService.stop();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received. Closing HTTP server and database pool...');
  watchdogService.stop();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});
