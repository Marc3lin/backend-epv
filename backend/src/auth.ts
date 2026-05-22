import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { env } from "./env.js";
import type { Role } from "@prisma/client";
import { prisma } from "./prisma.js";

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
};

export function signToken(user: AuthUser) {
  return jwt.sign(user, env.JWT_SECRET, { expiresIn: "7d" });
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return reply.code(401).send({ message: "Login obrigatório." });
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, email: true, fullName: true, role: true }
    });
    if (!user) return reply.code(401).send({ message: "Sessão inválida." });
    request.user = user;
  } catch {
    return reply.code(401).send({ message: "Sessão inválida." });
  }
}

export function requireRole(roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ message: "Permissão insuficiente." });
    }
  };
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }
}
