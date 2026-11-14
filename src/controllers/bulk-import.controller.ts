import { Request, Response } from 'express';
import { bulkImportService } from '../services/bulk-import.service.js';

export class BulkImportController {
  /**
   * POST /api/v1/bulk-import/validate
   * Uploads and parses CSV to detect syntax errors and database collisions
   */
  async validateCsv(req: Request, res: Response): Promise<void> {
    try {
      let buffer: Buffer | string | undefined;

      if (req.file) {
        buffer = req.file.buffer;
      } else if (req.body && req.body.csv) {
        buffer = req.body.csv;
      }

      if (!buffer) {
        res.status(400).json({
          success: false,
          message: 'CSV file or raw CSV text payload is required.',
        });
        return;
      }

      const report = await bulkImportService.validateCsv(buffer);

      res.status(200).json({
        success: true,
        message: `Validated ${report.totalRows} row(s): ${report.validCount} valid, ${report.conflictCount} conflict(s).`,
        data: report,
      });
    } catch (err: any) {
      console.error('❌ Error validating CSV import:', err);
      res.status(400).json({
        success: false,
        message: err.message || 'Failed to parse and validate CSV file.',
      });
    }
  }

  /**
   * POST /api/v1/bulk-import/commit
   * Atomically commits validated rows into users and enrollments
   */
  async commitCsv(req: Request, res: Response): Promise<void> {
    try {
      const { rows } = req.body;

      if (!Array.isArray(rows) || rows.length === 0) {
        res.status(400).json({
          success: false,
          message: 'An array of validated rows is required to execute commit.',
        });
        return;
      }

      const result = await bulkImportService.commitCsv(rows);

      res.status(200).json({
        success: true,
        message: `Bulk import committed: ${result.createdUserCount} new student account(s) created, ${result.enrolledCount} new enrollment(s) registered.`,
        data: result,
      });
    } catch (err: any) {
      console.error('❌ Error committing CSV import:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to commit validated records to database.',
      });
    }
  }
}

export const bulkImportController = new BulkImportController();
export default bulkImportController;
