import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import * as csv from 'fast-csv';
import ExcelJS from 'exceljs';
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
   * Helper to format time into 12-hour AM/PM format (non-military)
   */
  format12HourTime(date: Date | string | null | undefined): string {
    if (!date) return '--:--:--';
    const d = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(d.getTime())) return '--:--:--';
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  /**
   * Helper to format short 12-hour time without seconds
   */
  format12HourShort(date: Date | string | null | undefined): string {
    if (!date) return '--:--';
    const d = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  /**
   * Helper to retrieve unified session report data, enrolled roster, and summary statistics
   */
  async getSessionReportData(sessionId: string): Promise<{
    session: any;
    roster: RosterItem[];
    statsObj: {
      totalEnrolled: number;
      presentCount: number;
      lateCount: number;
      cutCount: number;
      excusedCount: number;
      absentCount: number;
      attendanceRate: string;
    };
  }> {
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

    const enrollments = await prisma.enrollment.findMany({
      where: { sectionId: session.sectionId },
      include: { student: true },
      orderBy: { student: { lastName: 'asc' } },
    });

    const logsByStudent = new Map(session.attendanceLogs.map((log) => [log.studentId, log]));

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
        tapTime: log?.tapTimestamp ? this.format12HourTime(log.tapTimestamp) : '--:--:--',
        isOverride: log?.isManualOverride ? 'YES' : 'NO',
        remarks: log?.overrideReason || (log?.status === 'ABSENT' ? 'Unlogged at Session Close' : 'Normal Hardware Check-in'),
      };
    });

    const totalEnrolled = roster.length;
    const presentCount = roster.filter((r) => r.status === 'PRESENT').length;
    const lateCount = roster.filter((r) => r.status === 'LATE').length;
    const cutCount = roster.filter((r) => r.status === 'CUT').length;
    const excusedCount = roster.filter((r) => r.status === 'EXCUSED').length;
    const absentCount = roster.filter((r) => r.status === 'ABSENT').length;
    const attendanceRate = totalEnrolled > 0 ? (((presentCount + lateCount + excusedCount) / totalEnrolled) * 100).toFixed(1) : '0';

    return {
      session,
      roster,
      statsObj: {
        totalEnrolled,
        presentCount,
        lateCount,
        cutCount,
        excusedCount,
        absentCount,
        attendanceRate,
      },
    };
  }

  /**
   * Generates Canvas SIS CSV export (Student ID, Name, Attendance Grade score out of 100)
   */
  async generateCanvasSisCsv(sessionId: string): Promise<string> {
    const { roster } = await this.getSessionReportData(sessionId);
    const rows = roster.map((item) => {
      let grade = 0;
      if (item.status === 'PRESENT') grade = 100;
      else if (item.status === 'LATE') grade = 80;
      else if (item.status === 'EXCUSED') grade = 100;
      else if (item.status === 'CUT') grade = 0;
      else if (item.status === 'ABSENT') grade = 0;

      return {
        'Student ID': item.studentId,
        'Name': item.fullName,
        'Attendance Grade': grade,
      };
    });

    return csv.writeToString(rows, { headers: true });
  }

  /**
   * Generates Moodle Attendance plugin CSV export (P, L, E, A notation columns)
   */
  async generateMoodleAttendanceCsv(sessionId: string): Promise<string> {
    const { roster } = await this.getSessionReportData(sessionId);
    const rows = roster.map((item) => {
      let code = 'A';
      let p = 0;
      let l = 0;
      let e = 0;
      let a = 0;

      if (item.status === 'PRESENT') {
        code = 'P';
        p = 1;
      } else if (item.status === 'LATE') {
        code = 'L';
        l = 1;
      } else if (item.status === 'EXCUSED') {
        code = 'E';
        e = 1;
      } else {
        code = 'A';
        a = 1;
      }

      return {
        'Student ID': item.studentId,
        'Name': item.fullName,
        'Email': item.email,
        'Attendance Code': code,
        'P': p,
        'L': l,
        'E': e,
        'A': a,
      };
    });

    return csv.writeToString(rows, { headers: true });
  }

  /**
   * Generates Formal Institutional Master PDF with university header, punctuality breakdown, and instructor signature block
   */
  async generateInstitutionalMasterPdf(sessionId: string): Promise<Buffer> {
    const { session, roster, statsObj } = await this.getSessionReportData(sessionId);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        info: {
          Title: `ORCHESTRA Institutional Master Attendance Manifest - ${session.section.sectionCode}`,
          Author: 'University Registrar / ORCHESTRA Framework',
          Subject: 'Formal Institutional Academic Attendance Audit',
        },
      });

      const buffers: Buffer[] = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const brandDark = '#0F172A';
      const brandNavy = '#1E3A8A';
      const brandBlue = '#2563EB';
      const brandGold = '#B45309';
      const textMuted = '#475569';
      const borderLine = '#CBD5E1';

      // 1. UNIVERSITY FORMAL HEADER
      doc.rect(36, 36, 523, 4).fill(brandNavy);

      doc.fillColor(brandDark).font('Helvetica').fontSize(8).text('Republic of the Philippines', 36, 46, { align: 'center', width: 523 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(brandNavy).text('UNIVERSITY OF SCIENCE AND TECHNOLOGY OF SOUTHERN PHILIPPINES', 36, 57, { align: 'center', width: 523 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(brandDark).text('COLLEGE OF COMPUTER STUDIES', 36, 72, { align: 'center', width: 523 });
      doc.font('Helvetica').fontSize(8).fillColor(textMuted).text('Department of Information Technology & Computer Architecture Laboratory', 36, 85, { align: 'center', width: 523 });

      // Decorative Accent Line
      doc.moveTo(36, 98).lineTo(559, 98).lineWidth(1.5).strokeColor(brandNavy).stroke();
      doc.moveTo(36, 101).lineTo(559, 101).lineWidth(0.5).strokeColor(brandGold).stroke();

      // Document Title
      doc.font('Helvetica-Bold').fontSize(12).fillColor(brandNavy).text('OFFICIAL INSTITUTIONAL MASTER ATTENDANCE MANIFEST', 36, 108, { align: 'center', width: 523 });
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(textMuted).text('Automated Cryptographic Hardware Ingress Telemetry & Tamper-Evident Session Log', 36, 122, { align: 'center', width: 523 });

      // 2. ACADEMIC SESSION METADATA BLOCK
      const metaBoxY = 135;
      doc.roundedRect(36, metaBoxY, 523, 56, 4).fillAndStroke('#F8FAFC', borderLine);

      const col1X = 48;
      const col2X = 220;
      const col3X = 390;

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(textMuted).text('COURSE & SECTION:', col1X, metaBoxY + 8);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(brandDark).text(`${session.section.sectionCode}`, col1X, metaBoxY + 18);
      doc.font('Helvetica').fontSize(7.5).fillColor(textMuted).text(`${session.section.courseName}`, col1X, metaBoxY + 30, { width: 160 });

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(textMuted).text('INSTRUCTOR-IN-CHARGE:', col2X, metaBoxY + 8);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(brandDark).text(`Prof. ${session.faculty.firstName} ${session.faculty.lastName}`, col2X, metaBoxY + 18);
      doc.font('Helvetica').fontSize(7.5).fillColor(textMuted).text(`${session.faculty.email}`, col2X, metaBoxY + 30);

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(textMuted).text('LOCATION & TERMINAL NODE:', col3X, metaBoxY + 8);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(brandDark).text(`${session.section.roomNumber} [${session.terminalId}]`, col3X, metaBoxY + 18);
      const startFmt = this.format12HourShort(session.startTime);
      const endFmt = session.endTime ? this.format12HourShort(session.endTime) : 'Ongoing';
      const dateFmt = new Date(session.startTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      doc.font('Helvetica').fontSize(7.5).fillColor(textMuted).text(`${dateFmt} (${startFmt} - ${endFmt})`, col3X, metaBoxY + 30);

      // 3. PUNCTUALITY COMPLIANCE BREAKDOWN BOX
      const punctBoxY = 198;
      doc.roundedRect(36, punctBoxY, 523, 44, 4).fillAndStroke('#F1F5F9', '#94A3B8');

      // Grace period rule line
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(brandNavy).text(
        `POLICY THRESHOLDS: Late Grace Window: ${session.lateThresholdMins}m | Session Cut-off: ${session.cutThresholdMins}m | Anti-Proxy Pacing: 3000ms`,
        48,
        punctBoxY + 6
      );

      // Metric Ribbon
      const statCardW = 71;
      const statCardGap = 4;
      const statY = punctBoxY + 18;

      const pCards = [
        { label: 'ENROLLED', value: statsObj.totalEnrolled, color: '#0F172A' },
        { label: 'PRESENT', value: statsObj.presentCount, color: '#065F46' },
        { label: 'LATE', value: statsObj.lateCount, color: '#854D0E' },
        { label: 'CUT', value: statsObj.cutCount, color: '#9A3412' },
        { label: 'EXCUSED', value: statsObj.excusedCount, color: '#1E40AF' },
        { label: 'ABSENT', value: statsObj.absentCount, color: '#991B1B' },
        { label: 'ATTENDANCE', value: `${statsObj.attendanceRate}%`, color: '#1E3A8A' },
      ];

      pCards.forEach((card, idx) => {
        const x = 44 + idx * (statCardW + statCardGap);
        doc.roundedRect(x, statY, statCardW, 20, 2).fill('#FFFFFF');
        doc.font('Helvetica-Bold').fontSize(9).fillColor(card.color).text(`${card.value}`, x, statY + 3, { width: statCardW, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(textMuted).text(card.label, x, statY + 12, { width: statCardW, align: 'center' });
      });

      // 4. ATTENDANCE ROSTER TABLE
      let tableY = 250;
      const renderTableHeader = (y: number) => {
        doc.rect(36, y, 523, 16).fill(brandNavy);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7);
        doc.text('#', 42, y + 5);
        doc.text('STUDENT ID', 58, y + 5);
        doc.text('STUDENT FULL NAME', 140, y + 5);
        doc.text('CHECK-IN (12H)', 275, y + 5);
        doc.text('AUTH METHOD', 345, y + 5);
        doc.text('STATUS', 425, y + 5);
        doc.text('AUDIT REMARKS', 475, y + 5);
      };

      renderTableHeader(tableY);
      tableY += 16;

      roster.forEach((row, i) => {
        // Leave room for 100pt signature block on the last page
        if (tableY > 640) {
          doc.addPage();
          tableY = 40;
          renderTableHeader(tableY);
          tableY += 16;
        }

        const rowBg = i % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
        doc.rect(36, tableY, 523, 15).fill(rowBg);

        doc.fillColor(brandDark).font('Helvetica').fontSize(7.5);
        doc.text(`${row.index}`, 42, tableY + 4);
        doc.font('Helvetica-Bold').text(row.studentId, 58, tableY + 4);
        doc.font('Helvetica').text(row.fullName, 140, tableY + 4);
        doc.text(row.tapTime, 275, tableY + 4);
        doc.text(row.authMethod, 345, tableY + 4);

        let statusColor = '#065F46';
        if (row.status === 'LATE') statusColor = '#854D0E';
        if (row.status === 'CUT') statusColor = '#9A3412';
        if (row.status === 'ABSENT') statusColor = '#991B1B';
        if (row.status === 'EXCUSED') statusColor = '#1E40AF';

        doc.font('Helvetica-Bold').fillColor(statusColor).text(row.status, 425, tableY + 4);
        doc.font('Helvetica').fontSize(6.5).fillColor(textMuted).text(row.remarks.slice(0, 20), 475, tableY + 4);

        tableY += 15;
      });

      // 5. INSTRUCTOR & INSTITUTIONAL SIGNATURE BLOCK
      let sigBlockY = Math.max(tableY + 15, 680);
      if (sigBlockY > 690) {
        doc.addPage();
        sigBlockY = 60;
      }

      doc.moveTo(36, sigBlockY).lineTo(559, sigBlockY).lineWidth(0.5).strokeColor(borderLine).stroke();

      doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(textMuted).text(
        'CERTIFICATION: I hereby certify under administrative authority that the ingress entries above were electronically interrogated and cryptographically validated via the ORCHESTRA Edge Terminal trust boundary.',
        36,
        sigBlockY + 5,
        { width: 523, align: 'justify' }
      );

      const sigLineY = sigBlockY + 45;
      const leftSigX = 50;
      const rightSigX = 330;
      const sigLineW = 180;

      // Left: Faculty Instructor
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(brandDark).text('CERTIFIED CORRECT:', leftSigX, sigBlockY + 20);
      doc.moveTo(leftSigX, sigLineY).lineTo(leftSigX + sigLineW, sigLineY).strokeColor(brandDark).lineWidth(1).stroke();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(brandDark).text(`Prof. ${session.faculty.firstName} ${session.faculty.lastName}`, leftSigX, sigLineY + 4);
      doc.font('Helvetica').fontSize(7).fillColor(textMuted).text('Course Instructor / Faculty In-Charge', leftSigX, sigLineY + 14);
      doc.font('Helvetica').fontSize(7).fillColor(textMuted).text(`Date: ${new Date().toLocaleDateString('en-US')}`, leftSigX, sigLineY + 23);

      // Right: Dean / Department Chair
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(brandDark).text('VERIFIED & RECORDED:', rightSigX, sigBlockY + 20);
      doc.moveTo(rightSigX, sigLineY).lineTo(rightSigX + sigLineW, sigLineY).strokeColor(brandDark).lineWidth(1).stroke();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(brandDark).text('Department Chairperson / Academic Dean', rightSigX, sigLineY + 4);
      doc.font('Helvetica').fontSize(7).fillColor(textMuted).text('College of Computer Studies', rightSigX, sigLineY + 14);
      doc.font('Helvetica').fontSize(7).fillColor(textMuted).text('Date Verified: ________________________', rightSigX, sigLineY + 23);

      // Footer
      const footerY = 800;
      doc.font('Helvetica').fontSize(6.5).fillColor(textMuted).text(
        `Official Institutional Copy | Session ID: ${session.id.slice(0, 12)} | Terminal: ${session.terminalId} | Generated: ${new Date().toLocaleString('en-US')}`,
        36,
        footerY,
        { align: 'center', width: 523 }
      );

      doc.end();
    });
  }

  /**
   * Generates PDF, CSV, and Excel reports for a completed session
   */
  async generateSessionReports(sessionId: string): Promise<{
    pdfPath: string;
    csvPath: string;
    xlsxPath: string;
    pdfBuffer: Buffer;
    csvString: string;
    xlsxBuffer: Buffer;
  }> {
    const { session, roster, statsObj } = await this.getSessionReportData(sessionId);

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const pdfFilename = `ORCHESTRA_Roster_${session.section.sectionCode}_${sessionId.slice(0, 8)}_${timestampStr}.pdf`;
    const csvFilename = `ORCHESTRA_Roster_${session.section.sectionCode}_${sessionId.slice(0, 8)}_${timestampStr}.csv`;
    const xlsxFilename = `ORCHESTRA_Roster_${session.section.sectionCode}_${sessionId.slice(0, 8)}_${timestampStr}.xlsx`;

    const pdfPath = path.join(this.reportsDir, pdfFilename);
    const csvPath = path.join(this.reportsDir, csvFilename);
    const xlsxPath = path.join(this.reportsDir, xlsxFilename);

    // 1. Generate CSV
    const csvString = await this.generateCsvFile(csvPath, session, roster);

    // 2. Generate PDF
    const pdfBuffer = await this.generatePdfFile(pdfPath, session, roster, statsObj);

    // 3. Generate Excel
    const xlsxBuffer = await this.generateExcelFile(xlsxPath, session, roster, statsObj);

    // Update session record with paths
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        reportPdfPath: pdfPath,
        reportCsvPath: csvPath,
      },
    });

    return {
      pdfPath,
      csvPath,
      xlsxPath,
      pdfBuffer,
      csvString,
      xlsxBuffer,
    };
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
      'Session Start': this.format12HourShort(session.startTime),
      'Session End': session.endTime ? this.format12HourShort(session.endTime) : 'Ongoing',
      'Attendance Status': item.status,
      'Auth Method': item.authMethod,
      'Check-in Time (12-Hour)': item.tapTime,
      'Manual Override': item.isOverride,
      'Remarks': item.remarks,
    }));

    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(filePath);
      const csvStream = csv.format({ headers: true });

      let csvAccumulator = '';
      csvStream.on('data', (chunk) => {
        csvAccumulator += chunk.toString();
      });

      csvStream.pipe(ws);
      csvRows.forEach((row) => csvStream.write(row));
      csvStream.end();

      ws.on('finish', () => resolve(csvAccumulator));
      ws.on('error', (err) => reject(err));
    });
  }

  /**
   * Generates formatted Excel (.xlsx) workbook using ExcelJS
   */
  async generateExcelFile(
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
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ORCHESTRA Attendance Framework';
    workbook.lastModifiedBy = 'ORCHESTRA Server';
    workbook.created = new Date();
    workbook.modified = new Date();

    const sheet = workbook.addWorksheet('Attendance Roster', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });

    // Title Block
    sheet.mergeCells('A1:I1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'COLLEGE OF COMPUTER STUDIES - ATTENDANCE RECORD';
    titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 30;

    sheet.mergeCells('A2:I2');
    const subtitleCell = sheet.getCell('A2');
    subtitleCell.value = 'ORCHESTRA: RFID SESSION TRUST & ROSTER AUTOMATION';
    subtitleCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF2563EB' } };
    subtitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(2).height = 20;

    // Metadata Grid
    const startFmt = this.format12HourShort(session.startTime);
    const endFmt = session.endTime ? this.format12HourShort(session.endTime) : 'Ongoing';
    const sessionDate = new Date(session.startTime).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const metaRows = [
      ['Course & Section:', `${session.section.sectionCode} - ${session.section.courseName}`, '', 'Date:', sessionDate],
      ['Instructor:', `Prof. ${session.faculty.firstName} ${session.faculty.lastName} (${session.faculty.email})`, '', 'Session Time:', `${startFmt} - ${endFmt}`],
      ['Location & Terminal:', `${session.section.roomNumber} [Terminal: ${session.terminalId}]`, '', 'Grace Windows:', `Late: ${session.lateThresholdMins}m | Cut: ${session.cutThresholdMins}m`],
    ];

    metaRows.forEach((rowVals) => {
      const row = sheet.addRow(rowVals);
      row.getCell(1).font = { bold: true, color: { argb: 'FF475569' } };
      row.getCell(2).font = { bold: true, color: { argb: 'FF0F172A' } };
      row.getCell(4).font = { bold: true, color: { argb: 'FF475569' } };
      row.getCell(5).font = { bold: true, color: { argb: 'FF0F172A' } };
    });

    sheet.addRow([]); // Blank row

    // KPI Summary Header
    sheet.addRow(['ATTENDANCE KPI SUMMARY']);
    sheet.getCell(`A${sheet.rowCount}`).font = { bold: true, size: 12, color: { argb: 'FF1E293B' } };

    const kpiHeaderRow = sheet.addRow(['Enrolled', 'Present', 'Late', 'Cut', 'Excused', 'Absent', 'Attendance Rate']);
    kpiHeaderRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
      cell.alignment = { horizontal: 'center' };
    });

    const kpiValRow = sheet.addRow([
      stats.totalEnrolled,
      stats.presentCount,
      stats.lateCount,
      stats.cutCount,
      stats.excusedCount,
      stats.absentCount,
      `${stats.attendanceRate}%`,
    ]);
    kpiValRow.eachCell((cell, colNum) => {
      cell.font = { bold: true, size: 12 };
      cell.alignment = { horizontal: 'center' };
      if (colNum === 2) cell.font = { bold: true, size: 12, color: { argb: 'FF16A34A' } };
      if (colNum === 3) cell.font = { bold: true, size: 12, color: { argb: 'FFD97706' } };
      if (colNum === 4) cell.font = { bold: true, size: 12, color: { argb: 'FFEA580C' } };
      if (colNum === 6) cell.font = { bold: true, size: 12, color: { argb: 'FFDC2626' } };
    });

    sheet.addRow([]); // Blank row

    // Table Header
    const tableHeaderRow = sheet.addRow([
      '#',
      'Student ID',
      'Student Full Name',
      'Institutional Email',
      'Status',
      'Auth Method',
      'Check-in Time (12-Hour)',
      'Override?',
      'Remarks / Punctuality Detail',
    ]);
    tableHeaderRow.height = 24;

    tableHeaderRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Populate Roster Rows
    roster.forEach((item) => {
      const row = sheet.addRow([
        item.index,
        item.studentId,
        item.fullName,
        item.email,
        item.status,
        item.authMethod,
        item.tapTime,
        item.isOverride,
        item.remarks,
      ]);

      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(5).alignment = { horizontal: 'center' };
      row.getCell(6).alignment = { horizontal: 'center' };
      row.getCell(7).alignment = { horizontal: 'center' };
      row.getCell(8).alignment = { horizontal: 'center' };

      // Status color formatting
      const statusCell = row.getCell(5);
      statusCell.font = { bold: true };
      switch (item.status) {
        case 'PRESENT':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
          statusCell.font = { color: { argb: 'FF15803D' }, bold: true };
          break;
        case 'LATE':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF9C3' } };
          statusCell.font = { color: { argb: 'FFA16207' }, bold: true };
          break;
        case 'CUT':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEDD5' } };
          statusCell.font = { color: { argb: 'FFC2410C' }, bold: true };
          break;
        case 'EXCUSED':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
          statusCell.font = { color: { argb: 'FF1D4ED8' }, bold: true };
          break;
        case 'ABSENT':
        default:
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          statusCell.font = { color: { argb: 'FFB91C1C' }, bold: true };
          break;
      }
    });

    // Auto-fit column widths
    sheet.columns = [
      { key: 'index', width: 6 },
      { key: 'studentId', width: 16 },
      { key: 'fullName', width: 26 },
      { key: 'email', width: 30 },
      { key: 'status', width: 14 },
      { key: 'authMethod', width: 18 },
      { key: 'tapTime', width: 22 },
      { key: 'isOverride', width: 12 },
      { key: 'remarks', width: 32 },
    ];

    await workbook.xlsx.writeFile(filePath);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return buffer;
  }

  /**
   * Generates formatted PDF Master Attendance Report using PDFKit
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
      const startFmt = this.format12HourShort(session.startTime);
      const endFmt = session.endTime ? this.format12HourShort(session.endTime) : 'Ongoing';
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
      doc.text('TIME (12H)', 280, tableY + 6);
      doc.text('METHOD', 340, tableY + 6);
      doc.text('STATUS', 410, tableY + 6);
      doc.text('REMARKS', 465, tableY + 6);

      tableY += 20;

      roster.forEach((row, i) => {
        if (tableY > 750) {
          doc.addPage();
          tableY = 40;
          doc.rect(36, tableY, 523, 20).fill('#1E293B');
          doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
          doc.text('#', 42, tableY + 6);
          doc.text('STUDENT ID', 58, tableY + 6);
          doc.text('FULL NAME', 140, tableY + 6);
          doc.text('TIME (12H)', 280, tableY + 6);
          doc.text('METHOD', 340, tableY + 6);
          doc.text('STATUS', 410, tableY + 6);
          doc.text('REMARKS', 465, tableY + 6);
          tableY += 20;
        }

        const rowBg = i % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
        doc.rect(36, tableY, 523, 18).fill(rowBg);

        doc.fillColor(brandDark).font('Helvetica').fontSize(8);
        doc.text(`${row.index}`, 42, tableY + 5);
        doc.font('Helvetica-Bold').text(row.studentId, 58, tableY + 5);
        doc.font('Helvetica').text(row.fullName, 140, tableY + 5);
        doc.text(row.tapTime, 280, tableY + 5);
        doc.text(row.authMethod, 340, tableY + 5);

        // Status badge color
        let statusColor = '#065F46';
        if (row.status === 'LATE') statusColor = '#854D0E';
        if (row.status === 'CUT') statusColor = '#9A3412';
        if (row.status === 'ABSENT') statusColor = '#991B1B';
        if (row.status === 'EXCUSED') statusColor = '#1E40AF';

        doc.font('Helvetica-Bold').fillColor(statusColor).text(row.status, 410, tableY + 5);
        doc.font('Helvetica').fontSize(7).fillColor(textMuted).text(row.remarks.slice(0, 22), 465, tableY + 5);

        tableY += 18;
      });

      // --- FOOTER & AUDIT STAMP ---
      const footerY = 780;
      doc.moveTo(36, footerY).lineTo(559, footerY).strokeColor(borderLine).stroke();
      doc.fillColor(textMuted).font('Helvetica').fontSize(7);
      const generatedAtFmt = new Date().toLocaleString('en-US', { hour12: true });
      doc.text(
        `Generated: ${generatedAtFmt} | ORCHESTRA Edge-Cloud System | Anti-Proxy Verification Validated`,
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
