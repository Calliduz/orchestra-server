import nodemailer from 'nodemailer';
import { env } from './env.js';

let transporterInstance: nodemailer.Transporter | null = null;

export async function getTransporter(): Promise<nodemailer.Transporter> {
  if (transporterInstance) {
    return transporterInstance;
  }

  // If using ethereal and user didn't specify custom credentials, auto-generate ethereal account for testing
  if (env.SMTP_HOST === 'smtp.ethereal.email' && (!env.SMTP_USER || env.SMTP_USER === 'orchestra.system@ethereal.email')) {
    try {
      const testAccount = await nodemailer.createTestAccount();
      console.log('📬 Initialized Ethereal Test Mailer:', testAccount.user);
      transporterInstance = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      return transporterInstance;
    } catch (err) {
      console.warn('⚠️ Could not create Ethereal test account, falling back to mock transporter:', err);
    }
  }

  transporterInstance = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          }
        : undefined,
  });

  return transporterInstance;
}
