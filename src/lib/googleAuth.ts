import { env } from '../config/env';

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

interface TokenInfoResponse {
  aud?: string;
  sub?: string;
  expires_in?: string;
}

interface UserinfoResponse {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * Verifikasi Google access token (implicit flow) di sisi server:
 * 1. Cek ke tokeninfo bahwa token diterbitkan untuk GOOGLE_CLIENT_ID kita.
 * 2. Ambil profil dari userinfo dan cocokkan sub-nya.
 */
export async function verifyGoogleAccessToken(accessToken: string): Promise<GoogleProfile> {
  if (!env.googleClientId) {
    throw new Error('GOOGLE_CLIENT_ID belum dikonfigurasi di server');
  }

  const infoRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!infoRes.ok) {
    throw new Error('Token Google tidak valid');
  }
  const info = (await infoRes.json()) as TokenInfoResponse;
  if (!info.sub || info.aud !== env.googleClientId) {
    throw new Error('Token Google tidak valid');
  }

  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) {
    throw new Error('Token Google tidak valid');
  }
  const profile = (await userRes.json()) as UserinfoResponse;
  if (!profile.sub || profile.sub !== info.sub || !profile.email) {
    throw new Error('Token Google tidak valid');
  }
  if (profile.email_verified === false) {
    throw new Error('Email Google belum terverifikasi');
  }

  return {
    googleId: profile.sub,
    email: profile.email,
    name: profile.name ?? profile.email.split('@')[0],
    avatarUrl: profile.picture,
  };
}
