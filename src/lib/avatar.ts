import { z } from 'zod';

// Aturan avatar bersama user & project: URL https atau dataURL gambar, maks ~300rb char.
export const AVATAR_RE = /^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/;

export const avatarUrlField = z.string().max(300000).nullable().optional();
