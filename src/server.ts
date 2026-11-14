import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { initializeSocket } from './sockets/telemetry.socket.js';
import prisma from './config/prisma.js';
import { watchdogService } from './services/watchdog.service.js';

const server = http.createServer(app);

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

// Global Process Safety Guards
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('💥 [FATAL] Unhandled Promise Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err: Error) => {
  console.error('💥 [FATAL] Uncaught Exception:', err);
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
