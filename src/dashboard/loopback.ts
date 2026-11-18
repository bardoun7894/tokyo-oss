/**
 * Shared gate for the loopback-only internal endpoints (deploy offers, action offers).
 *
 * Authorises on socket.remoteAddress only. A request that carries X-Forwarded-For or
 * X-Real-IP is treated as proxied and refused: nginx connects from 127.0.0.1, so a
 * proxied request would otherwise look local (FR-A9).
 */

import type { Request, Response } from "express";
import { isLoopback } from "./internal-status";

export function loopbackOnly(req: Request, res: Response): boolean {
  const h = req.headers ?? {};
  const proxied = h["x-forwarded-for"] !== undefined || h["x-real-ip"] !== undefined;
  if (!proxied && isLoopback(req.socket?.remoteAddress)) return true;
  res.status(403).json({ error: "loopback only" });
  return false;
}
