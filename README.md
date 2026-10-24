# ORCHESTRA Server: Backend Telemetry & Roster Engine

**Orchestrated RFID Classroom Attendance Framework with Hardware-Enforced Session Trust and Roster Automation**  
*College of Computer Studies — Department of Computer Science & Information Technology*  
*Authors: Agbada, Altichie, Cabunoc, Dalupang, Macadat, Malate (October 2026)*

---

## Architecture & Technology Stack

- **Runtime & Framework**: Node.js (v20+), Express.js (v5), TypeScript.
- **Database & ORM**: PostgreSQL (Neon Serverless), Prisma ORM with connection pooling.
- **Real-Time Telemetry**: Socket.io WebSocket engine broadcasting session state changes, card scans, and threshold updates.
- **Roster & Document Automation**: PDFKit (official institutional PDF rosters), fast-csv (roster CSV export), Nodemailer (automated email delivery of reports to faculty upon session termination).
- **Security & Trust Layer**: 
  - Hardware API Key verification (`x-api-key: ORCHESTRA_ESP32_SECURE_TOKEN_2026`).
  - Database-level Anti-Passback constraint: `@@unique([sessionId, studentId])`.
  - Cryptographic 60s time-decaying 6-digit OTP generator for keypad fallback.
  - JWT Bearer authentication for faculty manual overrides.

---

## Core API Endpoints

### 1. Hardware REST Interface (ESP32 Terminal)
- `POST /api/v1/hardware/tap` — Evaluates physical RFID badge tap:
  - If terminal is `LOCKED` and card is non-faculty: returns `403 SESSION_LOCKED`.
  - If terminal is `LOCKED` and card is Faculty Master Badge (`A1B2C3D4`): opens session (`SESSION_STARTED`).
  - If terminal is `OPEN` and card is Faculty Master Badge: terminates session, auto-marks unrecorded students as `ABSENT`, compiles PDF/CSV, and emails them to the instructor (`SESSION_CLOSED`).
  - If terminal is `OPEN` and card is enrolled student: enforces anti-passback (`409 ALREADY_RECORDED`), computes punctuality (`PRESENT`, `LATE`, `CUT`), and dispatches email reverse-receipt.
- `POST /api/v1/hardware/otp` — Validates 6-digit PIN entered via physical 4x4 matrix keypad.
- `GET /api/v1/hardware/status/:terminalId` — Synchronizes terminal state upon ESP32 boot.

### 2. Session & Faculty Operations
- `GET /api/v1/sessions/active/:terminalId` — Returns live active session, section manifest, and real-time roster.
- `PATCH /api/v1/sessions/:id/thresholds` — Dynamically recalibrates late/cut thresholds, immediately updating attendance statuses.
- `PATCH /api/v1/sessions/:id/override` — Faculty manual status override (e.g. Clinic slip, Dean's excuse).
- `GET /api/v1/sessions/:id/export/pdf` — Streams compiled official PDF attendance roster.
- `GET /api/v1/sessions/:id/export/csv` — Streams compiled CSV roster spreadsheet.

### 3. Student Keypad OTP Fallback
- `POST /api/v1/otp/request` — Generates an ephemeral 60-second 6-digit numeric PIN for physical keypad entry.

---

## Setup & Local Development

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Environment Configuration**:
   ```bash
   cp .env.example .env
   # Populate DATABASE_URL, DATABASE_URL_POOLED, and JWT_SECRET
   ```

3. **Database Migration & Seeding**:
   ```bash
   npx prisma db push
   npm run prisma:seed
   ```

4. **Launch Development Server**:
   ```bash
   npm run dev
   ```

5. **Run End-to-End Hardware Test Suite**:
   ```bash
   npm run test:e2e
   ```
