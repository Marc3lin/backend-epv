import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./env.js";
import { registerRoutes } from "./routes.js";
import { rootDir } from "./assets.js";

const app = Fastify({ logger: true });

await app.register(helmet, {
  crossOriginResourcePolicy: { policy: "cross-origin" }
});

await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute"
});

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowedOrigins = new Set([
      env.FRONTEND_URL,
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:5174",
      "http://127.0.0.1:5175"
    ]);
    callback(null, allowedOrigins.has(origin));
  },
  credentials: true
});

await app.register(fastifyStatic, {
  root: rootDir,
  prefix: "/media/",
  decorateReply: false,
  maxAge: "7 days",
  immutable: true
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const message = error instanceof Error ? error.message : "Erro interno do servidor.";

  if (message.includes("reservation_no_active_overlap") || (error as { code?: string }).code === "P2002") {
    return reply.code(409).send({ message: "HorÃ¡rio acabou de ser reservado por outra pessoa. Escolha outro horÃ¡rio." });
  }

  if (message.includes("court_block_no_overlap") || message.includes("permanent_block_no_overlap")) {
    return reply.code(409).send({ message: "JÃ¡ existe um bloqueio conflitante para esse horÃ¡rio." });
  }

  if (
    message === "A selecao possui horarios repetidos ou conflitantes." ||
    message === "Existe reserva futura conflitante com esse horario permanente."
  ) {
    return reply.code(400).send({ message });
  }

  if (error instanceof ZodError) {
    return reply.code(400).send({
      message: "Dados inválidos.",
      issues: error.issues
    });
  }

  const businessMessages = [
    "A reserva mínima é de 1 hora.",
    "Não é possível reservar horários no passado.",
    "Reservas disponíveis das 08:00 às 22:00.",
    "Horário indisponível para esta quadra.",
    "Modalidade indisponível para esta quadra.",
    "A reserva deve ter no mínimo 1 hora e seguir intervalos de 30 minutos."
  ];

  if (businessMessages.includes(message)) {
    return reply.code(400).send({ message });
  }

  if ((error as { code?: string }).code === "P2025") {
    return reply.code(404).send({ message: "Registro não encontrado." });
  }

  if ((error as { code?: string }).code === "P2034") {
    return reply.code(409).send({ message: "Horário acabou de ser reservado por outra pessoa. Escolha outro horário." });
  }

  const statusCode = (error as { statusCode?: number }).statusCode;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return reply.code(statusCode).send({ message });
  }

  return reply.code(500).send({ message: "Erro interno do servidor." });
});

await registerRoutes(app);

await app.listen({ port: env.PORT, host: "0.0.0.0" });

app.log.info(`Arena EPV API em http://localhost:${env.PORT}`);
