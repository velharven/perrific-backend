# Purrific Backend API

Layanan backend API untuk aplikasi kolaborasi tim dan pengelolaan aktivitas harian. Layanan ini dibangun menggunakan Express.js, TypeScript, Prisma ORM, dan PostgreSQL, serta dilengkapi dengan Socket.io untuk komunikasi real-time.

## Kebutuhan sistem

- Node.js versi 18 atau lebih tinggi.
- PostgreSQL versi 14 atau lebih tinggi.
- npm atau package manager yang kompatibel.

## Langkah instalasi

1. Masuk ke direktori backend:

```bash
cd purrific-backend
```

2. Pasang dependensi proyek:

```bash
npm install
```

3. Buat file konfigurasi lingkungan:

```bash
cp .env.example .env
```

4. Sesuaikan variabel di dalam file `.env`:

```env
# Mode lingkungan
NODE_ENV=development

# Konfigurasi port server
PORT=4000
CLIENT_URL=http://localhost:5173

# Koneksi basis data PostgreSQL
DATABASE_URL="postgresql://postgres:password@localhost:5432/team_task_db?schema=public"

# Konfigurasi autentikasi JWT
JWT_SECRET=rahasia-token-jwt-panjang-dan-acak
JWT_EXPIRES_IN=7d
BCRYPT_ROUNDS=10

# Google OAuth (Opsional, untuk login Google)
GOOGLE_CLIENT_ID=

# Asal request yang diizinkan CORS (pisahkan dengan koma jika lebih dari satu)
CORS_ORIGIN=http://localhost:5173
```

5. Jalankan migrasi basis data dan pembuatan Prisma Client:

```bash
npm run prisma:migrate
```

6. Masukkan data awal pengujian (seeding):

```bash
npm run prisma:seed
```

Perintah ini membuat dua akun pengguna awal:
- Akun Admin: `admin@example.com` (password: `password123`)
- Akun Member: `member@example.com` (password: `password123`)
- Tim awal bernama `Tim Contoh` dengan kode undangan `CONTOH01`

7. Jalankan server dalam mode pengembangan:

```bash
npm run dev
```

Layanan backend berjalan di `http://localhost:4000`.

## Daftar perintah script

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Menjalankan server pengembangan dengan hot reload menggunakan `tsx watch`. |
| `npm run build` | Melakukan kompilasi TypeScript ke folder `dist` menggunakan `tsc`. |
| `npm start` | Menjalankan build produksi dari `dist/index.js` menggunakan `node`. |
| `npm run typecheck` | Memeriksa validitas tipe TypeScript tanpa menghasilkan file output (`tsc --noEmit`). |
| `npm run lint` | Menjalankan pemeriksaan format dan aturan kode menggunakan ESLint dan otomatis memperbaikinya. |
| `npm run prisma:generate` | Membuat ulang Prisma Client berdasarkan skema pada `prisma/schema.prisma`. |
| `npm run prisma:migrate` | Menjalankan migrasi skema database Prisma dalam mode pengembangan. |
| `npm run prisma:seed` | Menjalankan pengisian data awal dari `prisma/seed.ts`. |
| `npm run prisma:studio` | Membuka antarmuka grafis Prisma Studio untuk melihat dan mengedit data tabel di browser. |
| `npm test` | Menjalankan tes merge, antrean per pengguna, dan sinkronisasi kalender. |
| `npm run test:calendar-live` | Memeriksa integrasi dua arah dengan akun Google yang terhubung menggunakan tugas dan event sementara. |

## Pemeriksaan Google Calendar

Jalankan migrasi dan `npm run prisma:generate` sebelum tes. `npm test` menggunakan PostgreSQL dari `.env`, membuat pengguna fixture terpisah, dan membersihkannya setelah tes. Permintaan Google pada tes tersebut menggunakan mock.

Pemindahan seri Google menggunakan tabel jurnal `calendar_series_operations`. Sebelum menjalankan versi ini pada lingkungan lain, jalankan `npx prisma migrate deploy` lalu `npm run prisma:generate`, rilis backend, dan terakhir frontend. Migrasi `20260930000000_calendar_series_operations` menambahkan tabel baru tanpa menghapus jadwal yang ada.

Kejadian impor dapat dipindahkan melalui `POST /api/calendar/google/events/:eventId/move` dan diurungkan melalui `POST /api/calendar/google/series-operations/:operationId/undo`. Permintaan move memakai UUID `requestId` yang sama saat retry, cakupan `THIS_EVENT`/`THIS_AND_FOLLOWING`/`ALL_EVENTS`, waktu baru, dan rentang tampilan ISO `from`/`to`. Undo memerlukan rentang tampilan dan koneksi Google asal. Snapshot serta ETag mencegah Undo menimpa perubahan yang dibuat kemudian di Google/Notion Calendar. Aturan gabungan yang belum didukung tetap dapat dipindahkan sebagai satu kejadian.

Untuk pemeriksaan langsung, jalankan backend dan `npm run test:calendar-live`. Pemeriksaan ini membutuhkan `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, dan satu akun Google Calendar yang sudah terhubung. Jika terdapat beberapa akun, tentukan `CALENDAR_TEST_USER_ID`. Script membuat tugas pribadi dan event sementara, memeriksa perubahan dari project, Daily, dan Google beserta penghapusannya, lalu membersihkan fixture.

Sinkronisasi berjalan saat kartu berubah, kalender dibuka, akun Google berganti, aplikasi kembali aktif, atau jaringan tersambung. Provider frontend memeriksa perubahan setiap 30 detik selama aplikasi terlihat, online, dan akun Google terhubung. Pemeriksaan berhenti saat tab tersembunyi, logout, atau koneksi Google diputus; kegagalan dicoba kembali dengan jeda bertahap dari 5 hingga 60 detik.

`POST /api/calendar/google/auto-sync` menerima `startDate`, `endDate`, dan `hydrateRange?: boolean` (default `false`). Pembukaan kalender, perubahan rentang, dan tombol sinkronisasi menggunakan `hydrateRange: true` untuk mengimpor seluruh halaman pada rentang tersebut, meskipun sudah ada `syncToken`. Rentang berbeda pada koneksi yang sama diproses berurutan. Permintaan incremental menggunakan `syncToken` tanpa parameter rentang atau pengurutan, dan token baru disimpan setelah seluruh halaman berhasil diterapkan. Baseline canonical menggunakan `singleEvents=false` dan baseline awal dimuat di latar belakang setelah rentang tampilan siap. Event Google disimpan sebagai aktivitas `CUSTOM` dengan identitas koneksi dan event asal; impor ulang memperbarui tautan yang sama.

Perubahan lokal mengirim hanya event yang terkait. Jadwal dan jurnal akun lama disimpan terpisah dan kembali saat akun itu dihubungkan lagi. Tautan lama tanpa pemilik diverifikasi sebelum dihubungkan; tidak dikirim atau dihapus melalui akun baru. Perubahan lokal dicatat sebelum dikirim, sehingga kegagalan jaringan dapat dicoba kembali tanpa membuat event duplikat. Konflik pada field yang sama mengikuti waktu perubahan terbaru; perubahan pada field berbeda digabungkan. Penghapusan jadwal mempertahankan tugas asal untuk dijadwalkan ulang.

## Dokumentasi arsitektur

Untuk penjelasan rinci mengenai arsitektur kode internal, modul kontroler, rute, skema basis data, dan sistem otorisasi, silakan baca [codebase.md](file:///C:/Users/VelHarven/Music/Ta/purrific-backend/codebase.md).
