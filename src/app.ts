import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Terlalu banyak percobaan, coba lagi nanti.' },
  });

  app.use(
    cors({
      origin: env.frontendOrigins,
      credentials: true,
    }),
  );
  app.use(helmet());
  // 1MB: muat coverUrl dataURL (maks 400rb) + content (maks 100rb).
  // Default 100KB melempar 413 untuk foto sampul realistis (begitu juga
  // avatar 300KB yang sudah lebih dulu mengizinkannya di validasi).
  app.use(express.json({ limit: '1mb' }));
  // Limiter global longgar untuk baca/tulis biasa; auth tetap ketat di
  // bawah (anti brute-force login) karena limiter ini mencakup semua /api.
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 2000,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.use('/api/auth', authLimiter);
  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
