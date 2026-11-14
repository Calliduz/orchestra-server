import crypto from 'crypto';
import { getTransporter } from '../config/mailer.js';
import { env } from '../config/env.js';
import prisma from '../config/prisma.js';

export class MailerService {
  /**
   * Generates a cryptographic verification signature for attendance receipts
   */
  private generateSignature(logId: string, email: string, date: Date): string {
    const seed = `${logId}:${email}:${date.getTime()}`;
    const hash = crypto
      .createHmac('sha256', env.JWT_SECRET || 'orchestra-secret-key-2026')
      .update(seed)
      .digest('hex')
      .substring(0, 16)
      .toUpperCase();
    return `ORCH-${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
  }

  /**
   * Helper to format total attended minutes into a readable duration string
   */
  public formatDuration(totalMinutes: number): string {
    const safeMins = Math.max(0, totalMinutes);
    const hrs = Math.floor(safeMins / 60);
    const mins = safeMins % 60;
    if (hrs > 0) {
      return `${hrs}h ${mins}m`;
    }
    return `${mins} mins`;
  }

  /**
   * Dispatches formatted Digital Email Receipt upon Ingress (Check-In)
   * Subject: [ORCHESTRA] Attendance Ingress Confirmed: ${courseName}
   */
  async sendIngressReceipt(params: {
    logId: string;
    studentEmail: string;
    studentName: string;
    courseName: string;
    sectionCode: string;
    roomNumber: string;
    terminalId?: string;
    status?: string;
    tapTime: Date;
    authMethod: string;
  }): Promise<boolean> {
    try {
      const transporter = await getTransporter();

      const timeString = params.tapTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
      const dateString = params.tapTime.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      const verificationSignature = this.generateSignature(params.logId, params.studentEmail, params.tapTime);
      const attendanceStatus = params.status || 'PRESENT';
      const terminalNode = params.terminalId || 'Classroom Terminal';

      const htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <div style="background: #2563eb; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; font-size: 20px; letter-spacing: 0.5px;">ORCHESTRA Framework</h2>
            <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Real-Time Attendance Ingress Receipt</p>
          </div>
          <div style="padding: 24px;">
            <p style="font-size: 15px; color: #1e293b; margin-top: 0;">Dear <strong>${params.studentName}</strong>,</p>
            <p style="font-size: 14px; color: #475569; line-height: 1.5;">
              This is an automated digital receipt confirming that your student identification credential was successfully authenticated for class entry (Ingress):
            </p>
            
            <div style="background: #f8fafc; border-left: 4px solid #2563eb; padding: 14px 18px; margin: 20px 0; border-radius: 4px;">
              <table style="width: 100%; font-size: 13px; color: #334155;">
                <tr><td style="padding: 4px 0; font-weight: bold; width: 150px;">Course & Section:</td><td>${params.sectionCode} - ${params.courseName}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Location / Room:</td><td>${params.roomNumber}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Terminal ID:</td><td><code>${terminalNode}</code></td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Attendance Status:</td><td><span style="display:inline-block; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; background: ${attendanceStatus === 'LATE' ? '#fef3c7; color: #92400e;' : '#d1fae5; color: #065f46;'}">${attendanceStatus}</span></td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Ingress Timestamp:</td><td>${timeString} (${dateString})</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Authentication Method:</td><td>${params.authMethod}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Session Duration:</td><td>Active (In Progress)</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Verification Signature:</td><td><code style="font-size: 11px; background: #e2e8f0; padding: 2px 6px; border-radius: 3px;">${verificationSignature}</code></td></tr>
              </table>
            </div>

            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 14px; margin-top: 24px;">
              <p style="margin: 0; font-size: 13px; color: #991b1b; font-weight: bold;">⚠️ Multi-Layer Anti-Proxy Defense Notice:</p>
              <p style="margin: 6px 0 0; font-size: 12px; color: #b91c1c; line-height: 1.4;">
                If you did <strong>NOT</strong> present your credential at this terminal, someone may be attempting to proxy-check in with your ID. Please immediately inform your instructor or the department proctor.
              </p>
            </div>
          </div>
          <div style="background: #f1f5f9; padding: 12px 24px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0;">
            ORCHESTRA IoT Classroom Attendance Framework &bull; Hardware-Enforced Trust Protocol
          </div>
        </div>
      `;

      const info = await transporter.sendMail({
        from: env.SMTP_FROM,
        to: params.studentEmail,
        subject: `[ORCHESTRA] Attendance Ingress Confirmed: ${params.courseName}`,
        html: htmlContent,
      });

      console.log(`✉️ Ingress receipt delivered to ${params.studentEmail}: ${info.messageId}`);

      // Mark reverseReceiptSent in database if record exists
      try {
        await prisma.attendanceLog.updateMany({
          where: { id: params.logId },
          data: {
            reverseReceiptSent: true,
            receiptSentAt: new Date(),
          },
        });
      } catch (dbErr) {
        // Handled silently if logId was transient or mock
      }

      return true;
    } catch (err) {
      console.error(`⚠️ Failed to send ingress receipt to ${params.studentEmail}:`, err);
      return false;
    }
  }

  /**
   * Dispatches formatted Digital Email Receipt upon Egress (Check-Out)
   * Subject: [ORCHESTRA] Class Exit Confirmed: ${courseName} (Duration: ${duration})
   */
  async sendEgressReceipt(params: {
    logId: string;
    studentEmail: string;
    studentName: string;
    courseName: string;
    sectionCode: string;
    roomNumber: string;
    terminalId?: string;
    status?: string;
    tapTime: Date;
    egressTime: Date;
    totalMinutesAttended: number;
    authMethod: string;
  }): Promise<boolean> {
    try {
      const transporter = await getTransporter();
      const durationStr = this.formatDuration(params.totalMinutesAttended);

      const egressTimeString = params.egressTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
      const ingressTimeString = params.tapTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
      const dateString = params.egressTime.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      const verificationSignature = this.generateSignature(params.logId, params.studentEmail, params.egressTime);
      const attendanceStatus = params.status || 'PRESENT';
      const terminalNode = params.terminalId || 'Classroom Terminal';

      const htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <div style="background: #0f766e; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; font-size: 20px; letter-spacing: 0.5px;">ORCHESTRA Framework</h2>
            <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Class Exit &amp; Egress Receipt</p>
          </div>
          <div style="padding: 24px;">
            <p style="font-size: 15px; color: #1e293b; margin-top: 0;">Dear <strong>${params.studentName}</strong>,</p>
            <p style="font-size: 14px; color: #475569; line-height: 1.5;">
              This is an automated digital receipt confirming your checkout from the class session (Egress). Your physical classroom attendance duration has been verified and recorded:
            </p>
            
            <div style="background: #f0fdfa; border-left: 4px solid #0f766e; padding: 14px 18px; margin: 20px 0; border-radius: 4px;">
              <table style="width: 100%; font-size: 13px; color: #334155;">
                <tr><td style="padding: 4px 0; font-weight: bold; width: 150px;">Course & Section:</td><td>${params.sectionCode} - ${params.courseName}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Location / Room:</td><td>${params.roomNumber}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Terminal ID:</td><td><code>${terminalNode}</code></td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Attendance Status:</td><td><span style="display:inline-block; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; background: ${attendanceStatus === 'LATE' ? '#fef3c7; color: #92400e;' : '#d1fae5; color: #065f46;'}">${attendanceStatus}</span></td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Check-In (Ingress):</td><td>${ingressTimeString}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Check-Out (Egress):</td><td>${egressTimeString} (${dateString})</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Total Duration:</td><td><strong style="color: #0f766e; font-size: 14px;">${durationStr}</strong> (${params.totalMinutesAttended} minutes)</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Authentication Method:</td><td>${params.authMethod}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Verification Signature:</td><td><code style="font-size: 11px; background: #e2e8f0; padding: 2px 6px; border-radius: 3px;">${verificationSignature}</code></td></tr>
              </table>
            </div>

            <p style="font-size: 12px; color: #64748b; margin-top: 18px; line-height: 1.4;">
              This confirmation serves as your non-repudiable egress proof. If this egress record does not correspond to your actual class departure, please contact your course instructor.
            </p>
          </div>
          <div style="background: #f1f5f9; padding: 12px 24px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0;">
            ORCHESTRA IoT Classroom Attendance Framework &bull; Hardware-Enforced Trust Protocol
          </div>
        </div>
      `;

      const info = await transporter.sendMail({
        from: env.SMTP_FROM,
        to: params.studentEmail,
        subject: `[ORCHESTRA] Class Exit Confirmed: ${params.courseName} (Duration: ${durationStr})`,
        html: htmlContent,
      });

      console.log(`✉️ Egress receipt delivered to ${params.studentEmail}: ${info.messageId}`);
      return true;
    } catch (err) {
      console.error(`⚠️ Failed to send egress receipt to ${params.studentEmail}:`, err);
      return false;
    }
  }

  /**
   * Backward-compatible reverse-receipt notification delegator
   */
  async sendReverseReceipt(params: {
    logId: string;
    studentEmail: string;
    studentName: string;
    courseName: string;
    sectionCode: string;
    roomNumber: string;
    terminalId?: string;
    status?: string;
    tapTime: Date;
    authMethod: string;
  }): Promise<boolean> {
    return this.sendIngressReceipt(params);
  }

  /**
   * Dispatches Master Attendance PDF, CSV, and Excel reports to faculty or custom recipient
   */
  async sendFacultySessionReport(params: {
    facultyEmail: string;
    facultyName: string;
    sectionCode: string;
    courseName: string;
    pdfPath?: string;
    csvPath?: string;
    xlsxPath?: string;
    recipientEmail?: string;
    stats: {
      totalEnrolled: number;
      present: number;
      late: number;
      cut: number;
      absent: number;
      excused: number;
    };
  }): Promise<boolean> {
    try {
      const transporter = await getTransporter();
      const targetEmail = params.recipientEmail || params.facultyEmail;

      const htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <div style="background: #0f172a; color: #ffffff; padding: 24px; text-align: center;">
            <h2 style="margin: 0; font-size: 20px;">ORCHESTRA Master Attendance Roster</h2>
            <p style="margin: 6px 0 0; font-size: 13px; color: #94a3b8;">Class Session Finalized & Reconciled</p>
          </div>
          <div style="padding: 24px;">
            <p style="font-size: 15px; color: #1e293b; margin-top: 0;">Dear <strong>Prof. ${params.facultyName}</strong>,</p>
            <p style="font-size: 14px; color: #475569; line-height: 1.5;">
              The attendance report for <strong>${params.sectionCode} (${params.courseName})</strong> is ready. Unlogged students have been recorded as <em>ABSENT</em>, and the consolidated master attendance records are attached in official PDF, Excel (.xlsx), and CSV formats.
            </p>
            
            <div style="display: flex; gap: 10px; margin: 20px 0;">
              <div style="flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; text-align: center;">
                <div style="font-size: 18px; font-weight: bold; color: #0f172a;">${params.stats.totalEnrolled}</div>
                <div style="font-size: 11px; color: #64748b; font-weight: bold;">ENROLLED</div>
              </div>
              <div style="flex: 1; background: #ecfdf5; border: 1px solid #a7f3d0; padding: 12px; border-radius: 6px; text-align: center;">
                <div style="font-size: 18px; font-weight: bold; color: #065f46;">${params.stats.present}</div>
                <div style="font-size: 11px; color: #065f46; font-weight: bold;">PRESENT</div>
              </div>
              <div style="flex: 1; background: #fefce8; border: 1px solid #fde047; padding: 12px; border-radius: 6px; text-align: center;">
                <div style="font-size: 18px; font-weight: bold; color: #854d0e;">${params.stats.late}</div>
                <div style="font-size: 11px; color: #854d0e; font-weight: bold;">LATE</div>
              </div>
              <div style="flex: 1; background: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 6px; text-align: center;">
                <div style="font-size: 18px; font-weight: bold; color: #991b1b;">${params.stats.absent}</div>
                <div style="font-size: 11px; color: #991b1b; font-weight: bold;">ABSENT</div>
              </div>
            </div>

            <p style="font-size: 13px; color: #64748b;">
              Attached files:
              <br/>&bull; <code>${params.sectionCode}_Master_Attendance.pdf</code> (Formatted PDF Document)
              <br/>&bull; <code>${params.sectionCode}_Master_Attendance.xlsx</code> (Excel Workbook)
              <br/>&bull; <code>${params.sectionCode}_Master_Attendance.csv</code> (Spreadsheet Data)
            </p>
          </div>
          <div style="background: #f1f5f9; padding: 12px 24px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0;">
            Generated by ORCHESTRA IoT Classroom Attendance Framework
          </div>
        </div>
      `;

      const attachments = [];
      if (params.pdfPath) {
        attachments.push({
          filename: `${params.sectionCode}_Master_Attendance.pdf`,
          path: params.pdfPath,
        });
      }
      if (params.xlsxPath) {
        attachments.push({
          filename: `${params.sectionCode}_Master_Attendance.xlsx`,
          path: params.xlsxPath,
        });
      }
      if (params.csvPath) {
        attachments.push({
          filename: `${params.sectionCode}_Master_Attendance.csv`,
          path: params.csvPath,
        });
      }

      const info = await transporter.sendMail({
        from: env.SMTP_FROM,
        to: targetEmail,
        subject: `[Master Roster Report] ${params.sectionCode} - ${new Date().toLocaleDateString('en-US')}`,
        html: htmlContent,
        attachments,
      });

      console.log(`✉️ Master report delivered to ${targetEmail}: ${info.messageId}`);
      return true;
    } catch (err) {
      console.error(`⚠️ Failed to deliver master report to ${params.facultyEmail}:`, err);
      return false;
    }
  }
}

export const mailerService = new MailerService();
export default mailerService;
