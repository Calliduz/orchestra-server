import { parseString } from 'fast-csv';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import prisma from '../config/prisma.js';
import { hardwareService } from './hardware.service.js';

export interface CsvStudentRow {
  studentId: string;
  firstName: string;
  lastName: string;
  email: string;
  sectionCode: string;
  rfidUid?: string;
}

export interface ValidatedImportRow {
  rowNumber: number;
  data: CsvStudentRow;
  status: 'VALID' | 'CONFLICT';
  issues: string[];
  action: 'CREATE_USER_AND_ENROLL' | 'ENROLL_EXISTING_USER' | 'ALREADY_ENROLLED' | 'REJECT';
}

export interface ValidationReport {
  totalRows: number;
  validCount: number;
  conflictCount: number;
  rows: ValidatedImportRow[];
}

export class BulkImportService {
  /**
   * Parses CSV buffer or text into normalized array of row objects
   */
  async parseCsvBuffer(bufferOrString: Buffer | string): Promise<Record<string, string>[]> {
    const csvContent = Buffer.isBuffer(bufferOrString)
      ? bufferOrString.toString('utf-8')
      : bufferOrString;

    return new Promise((resolve, reject) => {
      const results: Record<string, string>[] = [];
      parseString(csvContent, { headers: true, trim: true, ignoreEmpty: true })
        .on('data', (row) => results.push(row))
        .on('error', (err) => reject(err))
        .on('end', () => resolve(results));
    });
  }

  /**
   * Normalizes arbitrary CSV headers into standard keys
   */
  normalizeRowKeys(rawRow: Record<string, string>): CsvStudentRow {
    const normalized: any = {};
    for (const [key, val] of Object.entries(rawRow)) {
      const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (['studentid', 'studentno', 'studentnumber', 'id', 'idnumber'].includes(cleanKey)) {
        normalized.studentId = val.trim();
      } else if (['firstname', 'first', 'givenname', 'fname'].includes(cleanKey)) {
        normalized.firstName = val.trim();
      } else if (['lastname', 'last', 'surname', 'familyname', 'lname'].includes(cleanKey)) {
        normalized.lastName = val.trim();
      } else if (['email', 'emailaddress', 'institutionalemail'].includes(cleanKey)) {
        normalized.email = val.trim().toLowerCase();
      } else if (['sectioncode', 'section', 'class', 'coursecode'].includes(cleanKey)) {
        normalized.sectionCode = val.trim();
      } else if (['rfiduid', 'rfid', 'carduid', 'badgenumber', 'uid'].includes(cleanKey)) {
        normalized.rfidUid = val.trim();
      }
    }
    return {
      studentId: normalized.studentId || '',
      firstName: normalized.firstName || '',
      lastName: normalized.lastName || '',
      email: normalized.email || '',
      sectionCode: normalized.sectionCode || '',
      rfidUid: normalized.rfidUid || undefined,
    };
  }

  /**
   * Stage 1: In-memory parse & conflict detection
   * Detects missing fields, syntax errors, missing sections, and database collisions
   */
  async validateCsv(bufferOrString: Buffer | string): Promise<ValidationReport> {
    const rawRows = await this.parseCsvBuffer(bufferOrString);

    if (rawRows.length === 0) {
      throw new Error('CSV file contains no records or data rows.');
    }

    const parsedRows: CsvStudentRow[] = rawRows.map((r) => this.normalizeRowKeys(r));

    // Gather unique keys for batch database lookup
    const uniqueSectionCodes = Array.from(new Set(parsedRows.map((r) => r.sectionCode).filter(Boolean)));
    const uniqueStudentIds = Array.from(new Set(parsedRows.map((r) => r.studentId).filter(Boolean)));
    const uniqueEmails = Array.from(new Set(parsedRows.map((r) => r.email).filter(Boolean)));
    const uniqueRfids = Array.from(
      new Set(
        parsedRows
          .map((r) => (r.rfidUid ? hardwareService.normalizeRfid(r.rfidUid) : ''))
          .filter(Boolean)
      )
    );

    // Batch query existing sections
    const existingSections = await prisma.section.findMany({
      where: { sectionCode: { in: uniqueSectionCodes } },
    });
    const sectionMap = new Map(existingSections.map((s) => [s.sectionCode.toUpperCase(), s]));

    // Batch query existing users and their enrollments
    const existingUsers = await prisma.user.findMany({
      where: {
        OR: [
          { studentId: { in: uniqueStudentIds } },
          { email: { in: uniqueEmails } },
          { rfidUid: { in: uniqueRfids } },
        ],
      },
      include: {
        enrollments: true,
      },
    });

    const userByStudentId = new Map(existingUsers.filter((u) => u.studentId).map((u) => [u.studentId!, u]));
    const userByEmail = new Map(existingUsers.map((u) => [u.email.toLowerCase(), u]));
    const userByRfid = new Map(existingUsers.filter((u) => u.rfidUid).map((u) => [hardwareService.normalizeRfid(u.rfidUid!), u]));

    // Track internal duplicates & identity consistency within the uploaded CSV
    const studentById = new Map<string, { email: string; firstName: string; lastName: string; rfidUid?: string }>();
    const studentByEmail = new Map<string, { studentId: string; firstName: string; lastName: string; rfidUid?: string }>();
    const studentByRfid = new Map<string, { studentId: string; email: string }>();
    const seenSectionEnrollments = new Set<string>();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validatedRows: ValidatedImportRow[] = [];

    for (let i = 0; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      const rowNumber = i + 2; // Accounting for 1-based index and header line
      const issues: string[] = [];
      let action: ValidatedImportRow['action'] = 'CREATE_USER_AND_ENROLL';

      // 1. Validate required fields
      if (!row.studentId) issues.push('Student ID is required');
      if (!row.firstName) issues.push('First name is required');
      if (!row.lastName) issues.push('Last name is required');
      if (!row.email) issues.push('Email address is required');
      if (!row.sectionCode) issues.push('Section code is required');

      // 2. Validate email syntax
      if (row.email && !emailRegex.test(row.email)) {
        issues.push(`Invalid email format: "${row.email}"`);
      }

      // 3. Validate section existence
      const targetSection = row.sectionCode ? sectionMap.get(row.sectionCode.toUpperCase()) : null;
      if (row.sectionCode && !targetSection) {
        issues.push(`Section "${row.sectionCode}" does not exist in the database`);
      }

      let cleanRfid: string | undefined;
      if (row.rfidUid) {
        cleanRfid = hardwareService.normalizeRfid(row.rfidUid);
      }

      // 4. Intra-CSV duplicate & consistency checks
      const enrollmentKey = `${(row.studentId || row.email).toLowerCase()}_${(row.sectionCode || '').toUpperCase()}`;
      if (seenSectionEnrollments.has(enrollmentKey)) {
        issues.push(`Duplicate enrollment for student in section "${row.sectionCode}" in uploaded CSV`);
      } else {
        seenSectionEnrollments.add(enrollmentKey);
      }

      if (row.studentId) {
        const prevById = studentById.get(row.studentId);
        if (prevById) {
          if (row.email && prevById.email.toLowerCase() !== row.email.toLowerCase()) {
            issues.push(
              `Conflict: Student ID "${row.studentId}" is mapped to two different emails ("${prevById.email}" and "${row.email}") in CSV`
            );
          }
        } else {
          studentById.set(row.studentId, {
            email: row.email,
            firstName: row.firstName,
            lastName: row.lastName,
            rfidUid: cleanRfid,
          });
        }
      }

      if (row.email) {
        const prevByEmail = studentByEmail.get(row.email.toLowerCase());
        if (prevByEmail) {
          if (row.studentId && prevByEmail.studentId !== row.studentId) {
            issues.push(
              `Conflict: Email "${row.email}" is mapped to two different student IDs ("${prevByEmail.studentId}" and "${row.studentId}") in CSV`
            );
          }
        } else {
          studentByEmail.set(row.email.toLowerCase(), {
            studentId: row.studentId,
            firstName: row.firstName,
            lastName: row.lastName,
            rfidUid: cleanRfid,
          });
        }
      }

      if (cleanRfid) {
        const prevByRfid = studentByRfid.get(cleanRfid);
        if (prevByRfid) {
          const sameStudent =
            (row.studentId && prevByRfid.studentId === row.studentId) ||
            (row.email && prevByRfid.email.toLowerCase() === row.email.toLowerCase());
          if (!sameStudent) {
            issues.push(`Duplicate RFID UID "${cleanRfid}" assigned to multiple different students in CSV`);
          }
        } else {
          studentByRfid.set(cleanRfid, {
            studentId: row.studentId,
            email: row.email,
          });
        }
      }

      // 5. Database collision checks
      const userWithId = row.studentId ? userByStudentId.get(row.studentId) : null;
      const userWithEmail = row.email ? userByEmail.get(row.email.toLowerCase()) : null;
      const userWithRfid = cleanRfid ? userByRfid.get(cleanRfid) : null;

      // Check cross-identity conflicts
      if (userWithId && userWithEmail && userWithId.id !== userWithEmail.id) {
        issues.push(
          `Conflict: Student ID "${row.studentId}" belongs to ${userWithId.firstName} ${userWithId.lastName}, but email "${row.email}" belongs to ${userWithEmail.firstName} ${userWithEmail.lastName}`
        );
      }

      const existingUser = userWithId || userWithEmail;

      if (existingUser) {
        action = 'ENROLL_EXISTING_USER';

        // Check if already enrolled in this section
        if (targetSection) {
          const alreadyEnrolled = existingUser.enrollments.some((enr) => enr.sectionId === targetSection.id);
          if (alreadyEnrolled) {
            action = 'ALREADY_ENROLLED';
          }
        }
      }

      // RFID collision check against other users
      if (userWithRfid) {
        if (!existingUser || userWithRfid.id !== existingUser.id) {
          issues.push(
            `RFID UID "${cleanRfid}" is already assigned to ${userWithRfid.firstName} ${userWithRfid.lastName} (${userWithRfid.email})`
          );
        }
      }

      const status = issues.length === 0 ? 'VALID' : 'CONFLICT';
      if (status === 'CONFLICT') {
        action = 'REJECT';
      }

      validatedRows.push({
        rowNumber,
        data: row,
        status,
        issues,
        action,
      });
    }

    const validCount = validatedRows.filter((r) => r.status === 'VALID').length;
    const conflictCount = validatedRows.length - validCount;

    return {
      totalRows: validatedRows.length,
      validCount,
      conflictCount,
      rows: validatedRows,
    };
  }

  /**
   * Stage 2: Batch atomic upsert of validated rows
   */
  async commitCsv(rows: ValidatedImportRow[]): Promise<{
    totalProcessed: number;
    createdUserCount: number;
    enrolledCount: number;
    alreadyEnrolledCount: number;
    errors: string[];
  }> {
    const validRows = rows.filter((r) => r.status === 'VALID');
    if (validRows.length === 0) {
      throw new Error('No valid rows available to commit.');
    }

    const defaultPasswordHash = await bcrypt.hash('student123', 10);
    let createdUserCount = 0;
    let enrolledCount = 0;
    let alreadyEnrolledCount = 0;
    const errors: string[] = [];

    // Pre-cache all referenced sections
    const sectionCodes = Array.from(new Set(validRows.map((r) => r.data.sectionCode.toUpperCase())));
    const sections = await prisma.section.findMany({
      where: { sectionCode: { in: sectionCodes } },
    });
    const sectionMap = new Map(sections.map((s) => [s.sectionCode.toUpperCase(), s]));

    // Execute transactional imports atomically
    await prisma.$transaction(async (tx) => {
      for (const row of validRows) {
        const { studentId, firstName, lastName, email, sectionCode, rfidUid } = row.data;
        const section = sectionMap.get(sectionCode.toUpperCase());

        if (!section) {
          throw new Error(`Row ${row.rowNumber}: Section "${sectionCode}" could not be resolved.`);
        }

        const cleanRfid = rfidUid ? hardwareService.normalizeRfid(rfidUid) : null;

        // 1. Find or create User
        let user = await tx.user.findFirst({
          where: {
            OR: [{ studentId }, { email: email.toLowerCase() }],
          },
        });

        if (!user) {
          user = await tx.user.create({
            data: {
              studentId,
              email: email.toLowerCase(),
              firstName,
              lastName,
              password: defaultPasswordHash,
              role: Role.STUDENT,
              rfidUid: cleanRfid,
            },
          });
          createdUserCount++;
        } else {
          // Update existing user if missing RFID and row provides one
          if (cleanRfid && !user.rfidUid) {
            user = await tx.user.update({
              where: { id: user.id },
              data: { rfidUid: cleanRfid },
            });
          }
        }

        // 2. Upsert enrollment
        const existingEnr = await tx.enrollment.findUnique({
          where: {
            studentId_sectionId: {
              studentId: user.id,
              sectionId: section.id,
            },
          },
        });

        if (!existingEnr) {
          await tx.enrollment.create({
            data: {
              studentId: user.id,
              sectionId: section.id,
            },
          });
          enrolledCount++;
        } else {
          alreadyEnrolledCount++;
        }
      }
    });

    return {
      totalProcessed: validRows.length,
      createdUserCount,
      enrolledCount,
      alreadyEnrolledCount,
      errors,
    };
  }
}

export const bulkImportService = new BulkImportService();
export default bulkImportService;
