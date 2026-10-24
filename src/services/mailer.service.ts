import { getTransporter } from '../config/mailer.js';
import { env } from '../config/env.js';
import prisma from '../config/prisma.js';

export class MailerService {
  /**
   * Dispatches automated Reverse-Receipt Notification to student upon card tap / OTP verification
   */
  async sendReverseReceipt(params: {
    logId: string;
    studentEmail: string;
    studentName: string;
    courseName: string;
    sectionCode: string;
    roomNumber: string;
    tapTime: Date;
    authMethod: string;
  }): Promise<boolean> {
    try {
      const transporter = await getTransporter();

      const timeString = params.tapTime.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const dateString = params.tapTime.toLocaleDateString([], {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      const htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <div style="background: #2563eb; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; font-size: 20px; letter-spacing: 0.5px;">ORCHESTRA Framework</h2>
            <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Real-Time Attendance Security Alert</p>
          </div>
          <div style="padding: 24px;">
            <p style="font-size: 15px; color: #1e293b; margin-top: 0;">Dear <strong>${params.studentName}</strong>,</p>
            <p style="font-size: 14px; color: #475569; line-height: 1.5;">
              This is an automated reverse-receipt notification confirming that your student identification credential was successfully authenticated at the classroom terminal:
            </p>
            
            <div style="background: #f8fafc; border-left: 4px solid #2563eb; padding: 14px 18px; margin: 20px 0; border-radius: 4px;">
              <table style="width: 100%; font-size: 13px; color: #334155;">
                <tr><td style="padding: 4px 0; font-weight: bold; width: 140px;">Course & Section:</td><td>${params.sectionCode} - ${params.courseName}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Location / Room:</td><td>${params.roomNumber}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Authentication Time:</td><td>${timeString} (${dateString})</td></tr>
                <tr><td style="padding: 4px 0; font-weight: bold;">Method:</td><td>${params.authMethod}</td></tr>
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
        subject: `[Attendance Verification] ${params.sectionCode} - ${params.studentName}`,
        html: htmlContent,
      });

      console.log(`✉️ Reverse-receipt delivered to ${params.studentEmail}: ${info.messageId}`);

      // Mark reverseReceiptSent in database
      await prisma.attendanceLog.update({
        where: { id: params.logId },
        data: {
          reverseReceiptSent: true,
          receiptSentAt: new Date(),
        },
      });

      return true;
    } catch (err) {
      console.error(`⚠️ Failed to send reverse-receipt to ${params.studentEmail}:`, err);
      return false;
    }
  }

  /**
   * Dispatches Master Attendance PDF and CSV reports to faculty upon session closure
   */
  async sendFacultySessionReport(params: {
    facultyEmail: string;
    facultyName: string;
    sectionCode: string;
    courseName: string;
    pdfPath: string;
    csvPath: string;
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

      const htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <div style="background: #0f172a; color: #ffffff; padding: 24px; text-align: center;">
            <h2 style="margin: 0; font-size: 20px;">ORCHESTRA Master Attendance Roster</h2>
            <p style="margin: 6px 0 0; font-size: 13px; color: #94a3b8;">Class Session Finalized & Reconciled</p>
          </div>
          <div style="padding: 24px;">
            <p style="font-size: 15px; color: #1e293b; margin-top: 0;">Dear <strong>Prof. ${params.facultyName}</strong>,</p>
            <p style="font-size: 14px; color: #475569; line-height: 1.5;">
              Your class session for <strong>${params.sectionCode} (${params.courseName})</strong> has successfully concluded. Unlogged students have been recorded as <em>ABSENT</em>, and the consolidated master attendance records have been attached to this email in both official PDF and CSV spreadsheet formats.
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
              <br/>&bull; <code>${params.sectionCode}_Master_Attendance.pdf</code> (Formatted PDF Roster)
              <br/>&bull; <code>${params.sectionCode}_Master_Attendance.csv</code> (Spreadsheet Export)
            </p>
          </div>
          <div style="background: #f1f5f9; padding: 12px 24px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0;">
            Generated by ORCHESTRA IoT Classroom Attendance Framework
          </div>
        </div>
      `;

      const info = await transporter.sendMail({
        from: env.SMTP_FROM,
        to: params.facultyEmail,
        subject: `[Master Roster Report] ${params.sectionCode} - ${new Date().toLocaleDateString()}`,
        html: htmlContent,
        attachments: [
          {
            filename: `${params.sectionCode}_Master_Attendance.pdf`,
            path: params.pdfPath,
          },
          {
            filename: `${params.sectionCode}_Master_Attendance.csv`,
            path: params.csvPath,
          },
        ],
      });

      console.log(`✉️ Master report delivered to faculty ${params.facultyEmail}: ${info.messageId}`);
      return true;
    } catch (err) {
      console.error(`⚠️ Failed to deliver master report to faculty ${params.facultyEmail}:`, err);
      return false;
    }
  }
}

export const mailerService = new MailerService();
export default mailerService;
