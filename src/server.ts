import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { initializeSocket } from './sockets/telemetry.socket.js';
import prisma from './config/prisma.js';

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
});

// Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received. Closing HTTP server and database pool...');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received. Closing HTTP server and database pool...');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});
