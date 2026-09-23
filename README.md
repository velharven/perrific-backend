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

## Dokumentasi arsitektur

Untuk penjelasan rinci mengenai arsitektur kode internal, modul kontroler, rute, skema basis data, dan sistem otorisasi, silakan baca [codebase.md](file:///C:/Users/VelHarven/Music/Ta/purrific-backend/codebase.md).
