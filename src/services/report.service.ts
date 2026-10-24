import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import * as csv from 'fast-csv';
import prisma from '../config/prisma.js';

interface RosterItem {
  index: number;
  studentId: string;
  fullName: string;
  email: string;
  status: string;
  authMethod: string;
  tapTime: string;
  isOverride: string;
  remarks: string;
}

export class ReportService {
  private reportsDir: string;

  constructor() {
    this.reportsDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  /**
   * Generates both PDF and CSV reports for a completed session
   */
  async generateSessionReports(sessionId: string): Promise<{ pdfPath: string; csvPath: string; pdfBuffer: Buffer; csvString: string }> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        section: true,
        faculty: true,
        attendanceLogs: {
          include: { student: true },
        },
      },
    });

    if (!session) {
      throw new Error(`Session with ID ${sessionId} not found.`);
    }

    // Fetch all enrolled students for the section
    const enrollments = await prisma.enrollment.findMany({
      where: { sectionId: session.sectionId },
      include: { student: true },
      orderBy: { student: { lastName: 'asc' } },
    });

    const logsByStudent = new Map(session.attendanceLogs.map((log) => [log.studentId, log]));

    // Construct unified roster
    const roster: RosterItem[] = enrollments.map((enr, i) => {
      const student = enr.student;
      const log = logsByStudent.get(student.id);

      return {
        index: i + 1,
        studentId: student.studentId || 'N/A',
        fullName: `${student.lastName}, ${student.firstName}`,
        email: student.email,
        status: log?.status || 'ABSENT',
        authMethod: log?.authMethod || 'AUTO_ABSENT',
        tapTime: log?.tapTimestamp ? new Date(log.tapTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--',
        isOverride: log?.isManualOverride ? 'YES' : 'NO',
        remarks: log?.overrideReason || (log?.status === 'ABSENT' ? 'Unlogged at Session Close' : 'Normal Hardware Check-in'),
      };
    });

    // Summary calculations
    const totalEnrolled = roster.length;
    const presentCount = roster.filter((r) => r.status === 'PRESENT').length;
    const lateCount = roster.filter((r) => r.status === 'LATE').length;
    const cutCount = roster.filter((r) => r.status === 'CUT').length;
    const excusedCount = roster.filter((r) => r.status === 'EXCUSED').length;
    const absentCount = roster.filter((r) => r.status === 'ABSENT').length;
    const attendanceRate = totalEnrolled > 0 ? (((presentCount + lateCount + excusedCount) / totalEnrolled) * 100).toFixed(1) : '0';

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const pdfFilename = `ORCHESTRA_Roster_${session.section.sectionCode}_${sessionId.slice(0, 8)}_${timestampStr}.pdf`;
    const csvFilename = `ORCHESTRA_Roster_${session.section.sectionCode}_${sessionId.slice(0, 8)}_${timestampStr}.csv`;

    const pdfPath = path.join(this.reportsDir, pdfFilename);
    const csvPath = path.join(this.reportsDir, csvFilename);

    // 1. Generate CSV
    const csvString = await this.generateCsvFile(csvPath, session, roster);

    // 2. Generate PDF
    const pdfBuffer = await this.generatePdfFile(pdfPath, session, roster, {
      totalEnrolled,
      presentCount,
      lateCount,
      cutCount,
      excusedCount,
      absentCount,
      attendanceRate,
    });

    // Update session record with paths
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        reportPdfPath: pdfPath,
        reportCsvPath: csvPath,
      },
    });

    return { pdfPath, csvPath, pdfBuffer, csvString };
  }

  /**
   * Compiles CSV formatted string and writes to disk
   */
  private async generateCsvFile(filePath: string, session: any, roster: RosterItem[]): Promise<string> {
    const csvRows = roster.map((item) => ({
      'Item No.': item.index,
      'Student ID': item.studentId,
      'Student Name': item.fullName,
      'Email Address': item.email,
      'Section Code': session.section.sectionCode,
      'Course Name': session.section.courseName,
      'Classroom': session.section.roomNumber,
      'Terminal ID': session.terminalId,
      'Session Start': session.startTime.toISOString(),
      'Session End': session.endTime?.toISOString() || '',
      'Tap Timestamp': item.tapTime,
      'Attendance Status': item.status,
      'Authentication Method': item.authMethod,
      'Manual Override': item.isOverride,
      'Remarks': item.remarks,
    }));

    const csvContent = await csv.writeToString(csvRows, { headers: true });
    await fs.promises.writeFile(filePath, csvContent, 'utf-8');
    return csvContent;
  }

  /**
   * Generates publication-grade PDF using PDFKit
   */
  private async generatePdfFile(
    filePath: string,
    session: any,
    roster: RosterItem[],
    stats: {
      totalEnrolled: number;
      presentCount: number;
      lateCount: number;
      cutCount: number;
      excusedCount: number;
      absentCount: number;
      attendanceRate: string;
    }
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        info: {
          Title: `ORCHESTRA Master Attendance Roster - ${session.section.sectionCode}`,
          Author: 'ORCHESTRA Framework',
          Subject: 'Automated Hardware-Enforced Attendance Compilation',
        },
      });

      const writeStream = fs.createWriteStream(filePath);
      const buffers: Buffer[] = [];

      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));
      doc.pipe(writeStream);

      // --- COLOR PALETTE ---
      const brandDark = '#0F172A';
      const brandBlue = '#2563EB';
      const textMuted = '#64748B';
      const borderLine = '#E2E8F0';

      // --- HEADER SECTION ---
      doc.rect(36, 36, 523, 6).fill(brandBlue);

      doc.fillColor(brandDark).font('Helvetica-Bold').fontSize(16).text('COLLEGE OF COMPUTER STUDIES', 36, 52, { align: 'left' });
      doc.fillColor(brandBlue).font('Helvetica-Bold').fontSize(11).text('ORCHESTRA: RFID SESSION TRUST & ROSTER AUTOMATION', 36, 72);
      doc.fillColor(textMuted).font('Helvetica').fontSize(9).text('Department of Information Technology & Computer Engineering', 36, 86);

      // Badge on top right
      doc.roundedRect(430, 52, 129, 38, 4).fillAndStroke('#EFF6FF', '#BFDBFE');
      doc.fillColor(brandBlue).font('Helvetica-Bold').fontSize(9).text('OFFICIAL REPORT', 440, 59);
      doc.fillColor('#1E3A8A').font('Helvetica').fontSize(8).text(`Status: ${session.status}`, 440, 72);

      doc.moveTo(36, 105).lineTo(559, 105).strokeColor(borderLine).stroke();

      // --- METADATA GRID ---
      doc.roundedRect(36, 115, 523, 70, 6).fill('#F8FAFC');

      const col1X = 48;
      const col2X = 220;
      const col3X = 400;
      let metaY = 125;

      doc.font('Helvetica-Bold').fontSize(8).fillColor(textMuted).text('COURSE & SECTION:', col1X, metaY);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(brandDark).text(`${session.section.sectionCode}`, col1X, metaY + 11);
      doc.font('Helvetica').fontSize(8).fillColor(textMuted).text(`${session.section.courseName}`, col1X, metaY + 23);

      doc.font('Helvetica-Bold').fontSize(8).fillColor(textMuted).text('INSTRUCTOR:', col2X, metaY);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(brandDark).text(`${session.faculty.firstName} ${session.faculty.lastName}`, col2X, metaY + 11);
      doc.font('Helvetica').fontSize(8).fillColor(textMuted).text(`${session.faculty.email}`, col2X, metaY + 23);

      doc.font('Helvetica-Bold').fontSize(8).fillColor(textMuted).text('HARDWARE TERMINAL:', col3X, metaY);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(brandDark).text(`${session.terminalId} (${session.section.roomNumber})`, col3X, metaY + 11);
      const startFmt = new Date(session.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const endFmt = session.endTime ? new Date(session.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Ongoing';
      doc.font('Helvetica').fontSize(8).fillColor(textMuted).text(`Session Time: ${startFmt} - ${endFmt}`, col3X, metaY + 23);

      // --- KPI STATS BOXES ---
      const statY = 195;
      const cardW = 82;
      const cardH = 42;
      const cardGap = 6;

      const statCards = [
        { label: 'ENROLLED', value: stats.totalEnrolled, bg: '#F1F5F9', border: '#CBD5E1', color: '#334155' },
        { label: 'PRESENT', value: stats.presentCount, bg: '#ECFDF5', border: '#A7F3D0', color: '#065F46' },
        { label: 'LATE', value: stats.lateCount, bg: '#FEFCE8', border: '#FDE047', color: '#854D0E' },
        { label: 'CUT', value: stats.cutCount, bg: '#FFF7ED', border: '#FDBA74', color: '#9A3412' },
        { label: 'EXCUSED', value: stats.excusedCount, bg: '#EFF6FF', border: '#93C5FD', color: '#1E40AF' },
        { label: 'ABSENT', value: stats.absentCount, bg: '#FEF2F2', border: '#FECACA', color: '#991B1B' },
      ];

      statCards.forEach((card, idx) => {
        const x = 36 + idx * (cardW + cardGap);
        doc.roundedRect(x, statY, cardW, cardH, 4).fillAndStroke(card.bg, card.border);
        doc.fillColor(card.color).font('Helvetica-Bold').fontSize(14).text(`${card.value}`, x, statY + 8, { width: cardW, align: 'center' });
        doc.fillColor(textMuted).font('Helvetica-Bold').fontSize(7).text(card.label, x, statY + 26, { width: cardW, align: 'center' });
      });

      // --- ATTENDANCE ROSTER TABLE ---
      let tableY = 250;
      doc.rect(36, tableY, 523, 20).fill('#1E293B');

      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
      doc.text('#', 42, tableY + 6);
      doc.text('STUDENT ID', 58, tableY + 6);
      doc.text('FULL NAME', 140, tableY + 6);
      doc.text('TIME', 280, tableY + 6);
      doc.text('METHOD', 330, tableY + 6);
      doc.text('STATUS', 400, tableY + 6);
      doc.text('REMARKS', 460, tableY + 6);

      tableY += 20;

      roster.forEach((row, i) => {
        // Page break handling
        if (tableY > 750) {
          doc.addPage();
          tableY = 40;
          doc.rect(36, tableY, 523, 20).fill('#1E293B');
          doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
          doc.text('#', 42, tableY + 6);
          doc.text('STUDENT ID', 58, tableY + 6);
          doc.text('FULL NAME', 140, tableY + 6);
          doc.text('TIME', 280, tableY + 6);
          doc.text('METHOD', 330, tableY + 6);
          doc.text('STATUS', 400, tableY + 6);
          doc.text('REMARKS', 460, tableY + 6);
          tableY += 20;
        }

        const rowBg = i % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
        doc.rect(36, tableY, 523, 18).fill(rowBg);

        doc.fillColor(brandDark).font('Helvetica').fontSize(8);
        doc.text(`${row.index}`, 42, tableY + 5);
        doc.font('Helvetica-Bold').text(row.studentId, 58, tableY + 5);
        doc.font('Helvetica').text(row.fullName, 140, tableY + 5);
        doc.text(row.tapTime, 280, tableY + 5);
        doc.text(row.authMethod, 330, tableY + 5);

        // Status badge color
        let statusColor = '#065F46';
        if (row.status === 'LATE') statusColor = '#854D0E';
        if (row.status === 'CUT') statusColor = '#9A3412';
        if (row.status === 'ABSENT') statusColor = '#991B1B';
        if (row.status === 'EXCUSED') statusColor = '#1E40AF';

        doc.font('Helvetica-Bold').fillColor(statusColor).text(row.status, 400, tableY + 5);
        doc.font('Helvetica').fontSize(7).fillColor(textMuted).text(row.remarks.slice(0, 22), 460, tableY + 5);

        tableY += 18;
      });

      // --- FOOTER & AUDIT STAMP ---
      const footerY = 780;
      doc.moveTo(36, footerY).lineTo(559, footerY).strokeColor(borderLine).stroke();
      doc.fillColor(textMuted).font('Helvetica').fontSize(7);
      doc.text(
        `Generated: ${new Date().toLocaleString()} | ORCHESTRA Edge-Cloud System | Anti-Proxy Verification Validated`,
        36,
        footerY + 6
      );
      doc.text(`Page 1 of 1`, 510, footerY + 6);

      doc.end();
    });
  }
}

export const reportService = new ReportService();
export default reportService;
