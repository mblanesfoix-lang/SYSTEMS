import jwt from 'jsonwebtoken';
import { getUserById } from './db.js';
import { Request, Response, NextFunction } from 'express';

const DEV_JWT_SECRET = 'snfi-dev-secret-local-only';
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_SECRET;
// Vida maxima de un token de Rëff, en segundos: la misma que una sesion de Elvi-Ra (8 h).
const JWT_EXPIRES_IN = 8 * 60 * 60;

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET es obligatoria en produccion.');
  }
  console.warn('[WARN] JWT_SECRET no esta definida. Usando secreto local solo para desarrollo.');
}

/** maxSeconds acorta la vida del token (nunca la alarga por encima de JWT_EXPIRES_IN). */
export function signToken(payload: Record<string, unknown>, maxSeconds: number = JWT_EXPIRES_IN): string {
  const expiresIn = Math.max(1, Math.min(Math.floor(maxSeconds), JWT_EXPIRES_IN));
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

type SessionCheck = (sessionId: string) => Promise<boolean>;
let sessionCheck: SessionCheck | null = null;

/**
 * Integrado en SYSTEMS, cada token de Rëff nace de una sesion de Elvi-Ra (guest-token) y
 * lleva su identificador en `sid`. El servidor integrado registra aqui como comprobar que
 * esa sesion sigue abierta: al cerrarla, caducar o cambiar la contrasena, sus tokens de
 * Rëff dejan de valer. Con la comprobacion registrada, un token sin `sid` no vale.
 */
export function setSessionCheck(check: SessionCheck | null): void {
  sessionCheck = check;
}

async function originSessionAlive(payload: { sid?: unknown }): Promise<boolean> {
  if (!sessionCheck) return true;
  if (typeof payload.sid !== 'string' || !payload.sid) return false;
  return sessionCheck(payload.sid);
}

export function verifyToken(token: string): Record<string, unknown> | null {
  try {
    return jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user: AuthUser;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'Token ausente' });
    return;
  }
  const payload = verifyToken(token) as { userId?: string; sid?: unknown } | null;
  if (!payload) {
    res.status(401).json({ error: 'Token inválido o expirado' });
    return;
  }
  originSessionAlive(payload)
    .then(async (alive) => {
      if (!alive) {
        res.status(401).json({ error: 'La sesión de origen está cerrada o ha caducado' });
        return;
      }
      const userRow = await getUserById(payload.userId!);
      if (!userRow) {
        res.status(401).json({ error: 'Usuario no encontrado' });
        return;
      }
      req.user = {
        id: userRow.id,
        username: userRow.username,
        displayName: userRow.display_name,
        avatarUrl: userRow.avatar_url ?? null,
      };
      next();
    })
    .catch(next);
}
