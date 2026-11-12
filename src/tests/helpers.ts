import http from 'http';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import app from '../app.js';
import { env } from '../config/env.js';

export interface TestServer {
  server: http.Server;
  baseUrl: string;
  close: () => Promise<void>;
}

export function createTestToken(payload: {
  id: string;
  email: string;
  role: Role;
  firstName: string;
  lastName: string;
}): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '1h' });
}

export const adminUser = {
  id: 'admin-uuid-0001',
  email: 'admin@orchestra.edu',
  role: Role.ADMIN,
  firstName: 'System',
  lastName: 'Admin',
};

export const facultyUser = {
  id: 'faculty-uuid-0001',
  email: 'faculty@orchestra.edu',
  role: Role.FACULTY,
  firstName: 'Alan',
  lastName: 'Turing',
};

export const facultyUser2 = {
  id: 'faculty-uuid-0002',
  email: 'faculty2@orchestra.edu',
  role: Role.FACULTY,
  firstName: 'Ada',
  lastName: 'Lovelace',
};

export const studentUser = {
  id: 'student-uuid-0001',
  email: 'student@orchestra.edu',
  role: Role.STUDENT,
  firstName: 'Grace',
  lastName: 'Hopper',
};

export const adminToken = createTestToken(adminUser);
export const facultyToken = createTestToken(facultyUser);
export const facultyToken2 = createTestToken(facultyUser2);
export const studentToken = createTestToken(studentUser);

export async function startTestServer(): Promise<TestServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { server, baseUrl, close };
}
