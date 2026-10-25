import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { isOriginAllowed } from '../config/cors.js';

let io: SocketIOServer | null = null;

export function initializeSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`Origin ${origin} not allowed by ORCHESTRA WebSocket CORS policy`));
        }
      },
      methods: ['GET', 'POST', 'PATCH'],
      credentials: true,
    },
  });

  io.on('connection', (socket: Socket) => {
    console.log(`🔌 Telemetry Client Connected: ${socket.id}`);

    // Join room for specific terminal or session
    socket.on('join:terminal', (terminalId: string) => {
      socket.join(`terminal:${terminalId}`);
      console.log(`📡 Socket ${socket.id} joined room terminal:${terminalId}`);
    });

    socket.on('join:session', (sessionId: string) => {
      socket.join(`session:${sessionId}`);
      console.log(`📡 Socket ${socket.id} joined room session:${sessionId}`);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Telemetry Client Disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error('Socket.io has not been initialized yet!');
  }
  return io;
}

// -----------------------------------------------------------------
// TELEMETRY BROADCAST HELPERS
// -----------------------------------------------------------------

export function emitSessionStarted(payload: {
  sessionId: string;
  terminalId: string;
  sectionCode: string;
  courseName: string;
  roomNumber: string;
  facultyName: string;
  startTime: string;
  lateThresholdMins: number;
  cutThresholdMins: number;
  totalEnrolled: number;
  roster: any[];
}) {
  if (!io) return;
  console.log(`📢 Broadcasting [session:started] for session ${payload.sessionId}`);
  io.emit('session:started', payload);
  io.to(`terminal:${payload.terminalId}`).emit('session:started', payload);
}

export function emitSessionClosed(payload: {
  sessionId: string;
  terminalId: string;
  sectionCode: string;
  courseName: string;
  endTime: string;
  stats: {
    totalEnrolled: number;
    present: number;
    late: number;
    cut: number;
    absent: number;
    excused: number;
  };
  roster: any[];
}) {
  if (!io) return;
  console.log(`📢 Broadcasting [session:closed] for session ${payload.sessionId}`);
  io.emit('session:closed', payload);
  io.to(`terminal:${payload.terminalId}`).emit('session:closed', payload);
}

export function emitAttendanceUpdated(payload: {
  sessionId: string;
  terminalId: string;
  studentId: string;
  studentNumber: string;
  studentName: string;
  status: string;
  authMethod: string;
  tapTimestamp: string | null;
  isManualOverride: boolean;
  overrideReason?: string | null;
  stats: {
    totalEnrolled: number;
    present: number;
    late: number;
    cut: number;
    absent: number;
    excused: number;
  };
  roster: any[];
}) {
  if (!io) return;
  console.log(`📢 Broadcasting [attendance:updated] for student ${payload.studentNumber} -> ${payload.status}`);
  io.emit('attendance:updated', payload);
  io.to(`session:${payload.sessionId}`).emit('attendance:updated', payload);
}

export function emitPunctualityThresholdUpdated(payload: {
  sessionId: string;
  lateThresholdMins: number;
  cutThresholdMins: number;
  stats: {
    totalEnrolled: number;
    present: number;
    late: number;
    cut: number;
    absent: number;
    excused: number;
  };
  roster: any[];
}) {
  if (!io) return;
  console.log(`📢 Broadcasting [thresholds:updated] for session ${payload.sessionId}`);
  io.emit('thresholds:updated', payload);
  io.to(`session:${payload.sessionId}`).emit('thresholds:updated', payload);
}
