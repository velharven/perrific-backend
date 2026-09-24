# Panduan arsitektur backend Purrific

Dokumen ini menjelaskan struktur internal, skema data, modul kode, rute API, dan mekanisme perizinan pada layanan backend Purrific.

## Struktur direktori

```text
purrific-backend/
├── prisma/
│   ├── migrations/              # Berkas riwayat migrasi skema SQL
│   ├── schema.prisma            # Definisi model data, relasi, dan enum Prisma
│   └── seed.ts                  # Skrip pengisian data awal pengujian
├── src/
│   ├── config/
│   │   └── env.ts               # Pembacaan dan validasi variabel lingkungan (.env)
│   ├── controllers/             # Penanganan logika bisnis setiap modul endpoint
│   │   ├── activityController.ts
│   │   ├── authController.ts
│   │   ├── dashboardController.ts
│   │   ├── googleCalendarController.ts # Integrasi sinkronisasi Google Calendar dua arah
│   │   ├── index.ts
│   │   ├── noteController.ts
│   │   ├── notificationController.ts
│   │   ├── projectController.ts
│   │   ├── tableController.ts
│   │   ├── taskController.ts
│   │   └── teamController.ts
│   ├── jobs/                    # Penjadwalan tugas latar belakang (cron jobs)
│   │   ├── cleanup.ts           # Logika pembersihan data usang (misal notifikasi lama)
│   │   ├── index.ts
│   │   └── scheduler.ts         # Inisialisasi node-cron (retensi notifikasi & auto-sync kalender harian)
│   ├── lib/                     # Modul utilitas dan pembantu
│   │   ├── avatar.ts            # Validasi format avatar pengguna dan proyek
│   │   ├── errors.ts            # Standarisasi respon kesalahan HTTP
│   │   ├── googleAuth.ts        # Verifikasi token OAuth Google
│   │   ├── inviteCode.ts        # Generator kode acak unik untuk undangan tim
│   │   ├── jwt.ts               # Penandatanganan dan verifikasi token JWT
│   │   ├── permissions.ts       # Logika pemeriksaan izin berbasis peran proyek
│   │   ├── prisma.ts            # Singleton PrismaClient
│   │   ├── socket.ts            # Pengaturan server Socket.io dan helper emisi ruang
│   │   └── taskAssignees.ts     # Transformasi query dan include Prisma untuk task
│   ├── middleware/
│   │   ├── auth.ts              # Ekstraksi dan verifikasi JWT pada header HTTP
│   │   └── errorHandler.ts      # Penanganan galat global dan rute tidak ditemukan
│   ├── routes/                  # Definisi rute Express
│   │   ├── activity.routes.ts
│   │   ├── auth.routes.ts
│   │   ├── calendar.routes.ts   # Rute OAuth dan sinkronisasi Google Calendar
│   │   ├── dashboard.routes.ts
│   │   ├── index.ts
│   │   ├── note.routes.ts
│   │   ├── notification.routes.ts
│   │   ├── project.routes.ts
│   │   ├── table.routes.ts
│   │   ├── task.routes.ts
│   │   └── team.routes.ts
│   ├── app.ts                   # Perakitan middleware Express, CORS, rate limiter
│   └── index.ts                 # Titik masuk proses, binding HTTP server, dan socket
├── package.json
└── tsconfig.json
```

## Model data dan relasi basis data

Skema basis data dikelola menggunakan Prisma dengan PostgreSQL. Berikut adalah entitas utama pada sistem:

### 1. Pengguna dan tim
- User (`users`): Akun pengguna yang menyimpan identitas seperti email, username, nama, foto profil, dan kata sandi yang di-hash menggunakan bcrypt.
- Team (`teams`): Entitas organisasi atau kelompok kerja yang menaungi proyek dan anggota. Memiliki inviteCode dan masa berlaku inviteExpiresAt.
- TeamMember (`team_members`): Tabel junction antara User dan Team dengan role `TeamRole` bernilai `ADMIN` atau `MEMBER`.
- TeamJoinRequest (`team_join_requests`): Pengajuan bergabung ke tim melalui kode undangan dengan status `PENDING`, `APPROVED`, atau `REJECTED`.

### 2. Proyek, papan kanban, dan perizinan
- Project (`projects`): Proyek di bawah satu tim dengan status `ACTIVE` atau `ARCHIVED`.
- BoardColumn (`board_columns`): Kolom kanban dinamis milik proyek dengan nama, urutan angka (`order`), dan warna hex.
- ProjectRole (`project_roles`): Peran kustom per proyek (misal Front, Back, QA, atau sistem bawaan ADMIN, APPROVER, MEMBER) yang menyimpan daftar izin pada array string `permissions`.
- ProjectMember (`project_members`): Jabatan pengguna di suatu proyek yang mengaitkan User ke ProjectRole tertentu.

### 3. Tugas dan kolaborasi
- Task (`tasks`): Unit pekerjaan yang terhubung ke Project dan BoardColumn. Memiliki atribut nomor urut unik per proyek (`number`), judul, deskripsi, prioritas (`LOW`, `MEDIUM`, `HIGH`, `URGENT`), tenggat waktu (`dueDate`), status persetujuan (`ApprovalStatus`), serta relasi opsional subtask (`parentTaskId`).
- TaskAssignee (`task_assignees`): Hubungan many to many antara Task dan User yang bertanggung jawab mengerjakan tugas.
- TaskWatcher (`task_watchers`): Pengguna yang mengamati progres tugas tanpa berstatus sebagai penanggung jawab.
- TaskActivity (`task_activities`): Catatan riwayat aksi pada tugas seperti pemindahan kolom (`MOVED`), penambahan penanggung jawab (`ASSIGNED`), penghapusan penanggung jawab (`UNASSIGNED`), atau penambahan lampiran (`ATTACHMENT_ADDED`).
- Attachment (`attachments`): Berkas berkas atau gambar lampiran pada tugas yang disimpan dalam format data URL.
- Comment (`comments`): Komentar diskusi pada tugas.

### 4. Aktivitas harian dan catatan personal
- DailyActivity (`daily_activities`): Jadwal aktivitas per tanggal untuk pengguna perorangan. Menyimpan status (`PENDING`, `COMPLETED`, `SKIPPED`), jenis (`TASK`, `BREAKDOWN`, `CUSTOM`), ikon emoji, jam mulai, jam selesai, dan nilai kolom kustom dalam bentuk JSON (`customValues`). Dapat terhubung ke `Task` proyek.
- DailyColumn (`daily_columns`): Definisi properti kolom kustom pada perencana harian pengguna lintas tanggal. Memiliki tipe data `DailyColumnType` (`TEXT`, `NUMBER`, `DATE`, `SELECT`, `CHECKBOX`, `STATUS`, `PERSON`, `FILES`, `URL`, `PHONE`, `EMAIL`, `CATEGORY`, `START_TIME`, `END_TIME`).
- ChecklistItem (`checklist_items`): Sub-tugas checklist di dalam sebuah DailyActivity.
- Note (`notes`): Halaman catatan hierarkis per akun pengguna. Memiliki jenis `NoteKind` bernilai `NOTE`, `DASHBOARD`, `DAILY`, atau `TABLE`.
- Table (`tables`): Basis data berbaris dan berkolom yang melekat pada satu Note bertipe TABLE.
- TableColumn (`table_columns`): Definisi kolom tabel dengan tipe data `TEXT`, `NUMBER`, `SELECT`, `DATE`, atau `CHECKBOX`.
- TableRow (`table_rows`): Baris data tabel dengan nilai field bertipe JSON. Baris dapat ditautkan ke Note halaman terpisah.
- Notification (`notifications`): Notifikasi untuk pengguna dengan tipe penugasan, pembaruan tugas, tenggat waktu, atau pengingat aktivitas.

## Sistem autentikasi dan otorisasi

### Autentikasi
1. Autentikasi menggunakan JSON Web Token (JWT).
2. Token ditandatangani menggunakan `jwt.sign()` dengan payload `{ userId }` dan masa berlaku bawaan 7 hari.
3. Middleware `authenticate` pada `src/middleware/auth.ts` memverifikasi token dari header `Authorization: Bearer <token>` dan menyuntikkan properti `req.userId`.
4. Mendukung login Google melalui verifikasi token akses Google ke endpoint userinfo resmi Google.

### Otorisasi bertingkat
Sistem menerapkan otorisasi berlapis:
1. Pemeriksaan keanggotaan tim (`TeamMember`): Pengguna harus terdaftar sebagai anggota tim terkait.
2. Peran tim tingkat admin (`role === 'ADMIN'`): Admin tim memiliki wewenang penuh pada semua proyek di dalam timnya.
3. Sistem perizinan proyek berbasis peran (`permissions.ts`): Untuk anggota non-admin, fungsi `can(userId, projectId, permissionKey)` mengecek apakah peran pengguna memiliki izin yang diminta.

Kunci izin proyek yang didukung:
- `task.create`: Membuat tugas baru.
- `task.move`: Memindahkan kartu kanban antar kolom.
- `task.delete`: Menghapus tugas.
- `task.approve`: Menyetujui usulan tugas anggota tim.
- `column.manage`: Menambah, mengubah nama, mengubah warna, menggeser, dan menghapus kolom kanban.
- `role.manage`: Mengelola dan mengatur penugasan peran proyek.
- `project.manage`: Mengubah informasi nama proyek atau menghapus proyek.

## Ringkasan endpoint API

Semua rute diawali dengan prefix `/api`.

### Autentikasi (`/api/auth`)
- `POST /register`: Pendaftaran akun baru dengan email, password, nama, dan username.
- `POST /login`: Masuk menggunakan email atau username dan password.
- `POST /google`: Masuk atau mendaftar menggunakan token akses Google.
- `GET /me`: Mengambil data profil pengguna yang sedang login.
- `PATCH /profile`: Memperbarui nama, username, atau foto avatar akun.
- `PATCH /password`: Mengubah kata sandi akun pengguna lokal.
- `GET /check-username`: Memeriksa ketersediaan username yang diinginkan.

### Tim (`/api/teams`)
- `GET /`: Mengambil daftar tim yang diikuti pengguna.
- `POST /`: Membuat tim kerja baru (pembuat otomatis menjadi admin tim).
- `GET /:teamId`: Mengambil detail data tim beserta daftar anggotanya.
- `PATCH /:teamId`: Memperbarui nama dan deskripsi tim (khusus admin).
- `DELETE /:teamId`: Menghapus tim (khusus admin).
- `GET /:teamId/projects`: Mengambil daftar proyek pada tim terkait.
- `POST /:teamId/projects`: Membuat proyek baru di bawah tim.
- `GET /join/:inviteCode`: Mengambil pratinjau informasi tim sebelum bergabung.
- `POST /join/:inviteCode`: Mengajukan permohonan bergabung ke tim.
- `GET /:teamId/join-requests`: Mengambil daftar pengajuan bergabung yang tertunda (khusus admin).
- `POST /:teamId/join-requests/:requestId/approve`: Menyetujui pengajuan anggota baru.
- `POST /:teamId/join-requests/:requestId/reject`: Menolak pengajuan anggota baru.
- `POST /:teamId/invite-link/regenerate`: Membuat ulang kode undangan tim baru (khusus admin).
- `DELETE /:teamId/members/:userId`: Mengeluarkan anggota tim atau keluar dari tim.

### Proyek (`/api/projects`)
- `GET /:projectId`: Mengambil informasi proyek.
- `PATCH /:projectId`: Memperbarui profil dan avatar proyek.
- `DELETE /:projectId`: Menghapus proyek.
- `GET /:projectId/tasks`: Mengambil daftar seluruh tugas dalam proyek.
- `POST /:projectId/tasks`: Membuat tugas baru di proyek.
- `PATCH /:projectId/tasks/reorder`: Menyimpan urutan baru kartu kanban dalam satu kolom.
- `GET /:projectId/columns`: Mengambil daftar kolom kanban proyek.
- `POST /:projectId/columns`: Menambah kolom kanban baru.
- `PATCH /:projectId/columns/reorder`: Mengubah urutan kolom kanban.
- `PATCH /:projectId/columns/:columnId`: Memperbarui nama atau warna kolom.
- `DELETE /:projectId/columns/:columnId`: Menghapus kolom (memindahkan tugas ke kolom tujuan).
- `GET /:projectId/roles`: Mengambil daftar peran yang tersedia di proyek.
- `POST /:projectId/roles`: Membuat peran baru dengan konfigurasi izin tertentu.
- `PATCH /:projectId/roles/:roleId`: Memperbarui nama atau daftar izin peran kustom.
- `DELETE /:projectId/roles/:roleId`: Menghapus peran kustom (memindahkan anggota ke peran lain).
- `GET /:projectId/members`: Mengambil daftar anggota proyek beserta perannya.
- `PATCH /:projectId/members/:userId/role`: Menetapkan peran ke anggota proyek.
- `GET /:projectId/comments`: Mengambil seluruh komentar tugas untuk feed aktivitas proyek.
- `GET /:projectId/activities`: Mengambil seluruh log riwayat aktivitas pada proyek.
- `GET /:projectId/attachments`: Mengambil seluruh daftar lampiran file proyek.

### Tugas (`/api/tasks`)
- `GET /assigned/me`: Mengambil daftar seluruh tugas tim yang di-assign kepada pengguna yang sedang login beserta status aktivitas hariannya.
- `GET /:taskId`: Mengambil data detail satu tugas termasuk komentar dan lampiran.
- `PATCH /:taskId`: Memperbarui status kolom, judul, deskripsi, prioritas, tenggat, atau penanggung jawab tugas.
- `DELETE /:taskId`: Menghapus tugas.
- `POST /:taskId/comments`: Menambahkan komentar baru pada tugas.
- `DELETE /:taskId/comments/:commentId`: Menghapus komentar milik pengguna.
- `POST /:taskId/attachments`: Mengunggah berkas lampiran ke tugas.
- `DELETE /:taskId/attachments/:attachmentId`: Menghapus berkas lampiran.
- `POST /:taskId/watch`: Mengikuti pembaruan tugas sebagai pengamat (watcher).
- `DELETE /:taskId/watch`: Berhenti mengamati tugas.
- `POST /:taskId/approve`: Menyetujui usulan tugas yang berstatus PENDING.
- `POST /:taskId/reject`: Menolak usulan tugas yang berstatus PENDING.

### Integrasi Google Calendar (`/api/calendar`)
- `GET /google/status`: Mengambil status koneksi, email, nama, dan foto profil akun Google yang terhubung.
- `POST /google/connect`: Menghubungkan akun Google menggunakan access token OAuth.
- `POST /google/disconnect`: Memutus integrasi Google Calendar dan membersihkan kredensial token dari basis data.
- `GET /google/events`: Mengambil daftar event kalender Google pengguna dalam rentang waktu tertentu.
- `POST /google/sync-activity/:activityId`: Memicu sinkronisasi instan satu kegiatan harian spesifik ke Google Calendar.
- `POST /google/import`: Mengimpor event Google Calendar menjadi entri DailyActivity lokal.
- `POST /google/auto-sync`: Memicu sinkronisasi dua arah otomatis antara DailyActivity dan Google Calendar.
- `PATCH /google/events/:eventId`: Memperbarui data event kalender Google (judul, waktu mulai, selesai, deskripsi).
- `DELETE /google/events/:eventId`: Menghapus event pada Google Calendar dan melepaskan tautan Google event pada DailyActivity lokal.
- Logika sinkronisasi otomatis: Pembuatan, pembaruan, dan penghapusan `DailyActivity` secara otomatis menyelaraskan event Google Calendar terkait di latar belakang serta menyiarkan event real-time `calendar:synced` (`create`, `update`, `delete`).

### Aktivitas harian personal (`/api/activities`)
- `GET /me`: Mengambil daftar aktivitas harian pengguna dengan filter tanggal, pencarian, dan status (didukung buffer zona waktu).
- `POST /`: Membuat aktivitas harian baru.
- `PATCH /:activityId`: Mengubah informasi aktivitas (status, jam kerja, ikon, judul).
- `DELETE /:activityId`: Menghapus aktivitas harian.
- `POST /reorder`: Mengatur ulang urutan aktivitas harian.
- `POST /:activityId/duplicate`: Menduplikasi aktivitas harian beserta sub-checklistnya.
- `PATCH /:activityId/values`: Memperbarui nilai kolom kustom pada aktivitas tertentu.
- `GET /columns`: Mengambil daftar properti kolom kustom database harian milik pengguna.
- `POST /columns`: Menambahkan properti kolom kustom baru ke database harian.
- `POST /columns/reorder`: Mengatur ulang urutan kolom kustom.
- `PATCH /columns/:columnId`: Memperbarui nama, tipe, ikon, atau opsi kolom kustom.
- `DELETE /columns/:columnId`: Menghapus properti kolom kustom dari database harian.
- `POST /:activityId/checklist`: Menambahkan sub-item checklist pada aktivitas.
- `PATCH /checklist/:itemId`: Memperbarui teks atau status centang checklist.
- `DELETE /checklist/:itemId`: Menghapus sub-item checklist.

### Catatan dan tabel personal (`/api/notes` dan `/api/tables`)
- `GET /notes`: Mengambil seluruh catatan milik pengguna.
- `POST /notes`: Membuat halaman catatan baru (NOTE, DASHBOARD, DAILY, atau TABLE).
- `GET /notes/:noteId`: Mengambil detail konten satu catatan.
- `PATCH /notes/:noteId`: Memperbarui judul, konten teks, sampul, atau urutan catatan.
- `DELETE /notes/:noteId`: Menghapus catatan beserta sub-halaman di bawahnya.
- `GET /tables/:noteId`: Mengambil definisi kolom dan data baris tabel basis data personal.
- `PUT /tables/:noteId`: Menyimpan pembaruan struktur kolom dan nilai baris pada tabel.

### Dasbor dan notifikasi (`/api/dashboard` dan `/api/notifications`)
- `GET /dashboard/project/:projectId`: Menghitung metrik progres tugas proyek per kolom.
- `GET /dashboard/daily`: Menghitung metrik penyelesaian aktivitas harian pengguna untuk hari ini.
- `GET /notifications`: Mengambil daftar notifikasi pengguna terbaru.
- `PATCH /notifications/:notificationId/read`: Menandai notifikasi telah dibaca.

## Komunikasi real-time dan background scheduler

### Socket.io
Inisialisasi Socket.io berada di `src/lib/socket.ts`.
- Saat koneksi dimulai, token JWT divalidasi pada middleware handshake.
- Setiap koneksi soket pengguna otomatis bergabung ke ruang terisolasi `user:<userId>`.
- Ruang terisolasi tim dapat dibentuk menggunakan penamaan `team:<teamId>`.
- Fungsi pembantu `emitToUser(userId, event, data)` dan `emitToTeam(teamId, event, data)` disediakan untuk menyiarkan event ke client yang relevan tanpa membocorkan data ke pihak lain.
- Event `calendar:synced` dikirimkan secara terisolasi ke pengguna untuk memicu pembaruan jadwal instan tanpa perlu reload halaman.

### Background scheduler
Penjadwalan tugas latar belakang berada di `src/jobs/scheduler.ts`.
- Berjalan in-process menggunakan pustaka `node-cron`.
- Pembersihan retensi notifikasi: Menjalankan fungsi `pruneOldNotifications()` setiap hari pada pukul 03.00 pagi waktu server untuk menghapus notifikasi yang lebih tua dari 30 hari.
- Auto-sync Google Calendar harian: Menjalankan fungsi `runDailyGoogleCalendarAutoSync()` setiap tengah malam (pukul 00.00) untuk memperbarui sinkronisasi seluruh pengguna yang terhubung.
