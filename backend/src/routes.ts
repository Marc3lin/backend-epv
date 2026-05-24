import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { PaymentStatus, Prisma, ReservationStatus, Role, WhatsAppEvent } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma.js";
import { requireAuth, requireRole, signToken } from "./auth.js";
import { calculatePriceCents, getFallbackPriceConfig } from "./pricing.js";
import { createPixPayment, getMercadoPagoPayment } from "./payments.js";
import { logWhatsApp } from "./whatsapp.js";
import { siteAssets, teamPages } from "./assets.js";
import { env } from "./env.js";

const publicUser = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  mustChangePass: true
};

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function mercadoPagoNetCents(amountCents: number) {
  const feeMultiplier = 1 - env.MERCADO_PAGO_PIX_FEE_PERCENT / 100;
  return Math.max(0, Math.round(amountCents * feeMultiplier));
}

function reservationNetCents(reservation: { amountCents: number; payment?: { provider?: string | null } | null }) {
  return reservation.payment?.provider === "mercado_pago"
    ? mercadoPagoNetCents(reservation.amountCents)
    : reservation.amountCents;
}

function paymentNetCents(payment: { amountCents: number; provider?: string | null }) {
  return payment.provider === "mercado_pago"
    ? mercadoPagoNetCents(payment.amountCents)
    : payment.amountCents;
}

function centsFromMercadoPagoAmount(amount?: number) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function isMercadoPagoProvider(provider?: string | null) {
  return provider === "mercado_pago";
}

async function writeAuditLog(input: {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
}, db: Prisma.TransactionClient | typeof prisma = prisma) {
  await db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? undefined
    }
  }).catch(() => undefined);
}

function getSaoPauloDateTimeParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute")
  };
}

function ensureOperatingHours(startAt: Date, endAt: Date) {
  if (startAt.getTime() <= Date.now()) {
    throw new Error("Não é possível reservar horários no passado.");
  }

  const start = getSaoPauloDateTimeParts(startAt);
  const end = getSaoPauloDateTimeParts(endAt);
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  const sameLocalDay = start.year === end.year && start.month === end.month && start.day === end.day;
  const aligned = start.minute % 30 === 0 && end.minute % 30 === 0;

  if (!sameLocalDay || !aligned || startMinutes < 8 * 60 || endMinutes > 22 * 60 || endAt <= startAt) {
    throw new Error("Reservas disponíveis das 08:00 às 22:00.");
  }
}

function getSaoPauloDateParts(date: Date) {
  const local = new Date(date.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return {
    dayOfWeek: local.getDay(),
    minutes: local.getHours() * 60 + local.getMinutes()
  };
}

function minutesToLabel(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function parseHalfHourTime(value: string) {
  const match = /^([01]\d|2[0-3]):([03]0)$/.exec(value);
  if (!match) throw new Error("Use horários no formato HH:mm, de 30 em 30 minutos.");
  return Number(match[1]) * 60 + Number(match[2]);
}

function localDayRange(date: string) {
  return {
    dayStart: new Date(`${date}T00:00:00-03:00`),
    dayEnd: new Date(`${date}T23:59:59-03:00`)
  };
}

function ensureReservationDuration(durationMinutes: number) {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 60 || durationMinutes > 14 * 60 || durationMinutes % 30 !== 0) {
    throw new Error("A reserva deve ter no mínimo 1 hora e seguir intervalos de 30 minutos.");
  }
}

function assertNoInternalBatchConflict(items: Array<{ courtId: string; startAt: Date; endAt: Date }>) {
  for (let index = 0; index < items.length; index++) {
    for (let nextIndex = index + 1; nextIndex < items.length; nextIndex++) {
      const current = items[index];
      const next = items[nextIndex];
      if (current.courtId === next.courtId && current.startAt < next.endAt && current.endAt > next.startAt) {
        throw new Error("A selecao possui horarios repetidos ou conflitantes.");
      }
    }
  }
}

async function assertNoConflict(courtId: string, startAt: Date, endAt: Date, ignoreReservationId?: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const activeStatuses = [ReservationStatus.PENDING_PAYMENT, ReservationStatus.CONFIRMED];
  const conflict = await db.reservation.findFirst({
    where: {
      id: ignoreReservationId ? { not: ignoreReservationId } : undefined,
      courtId,
      status: { in: activeStatuses },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      startAt: { lt: endAt },
      endAt: { gt: startAt }
    }
  });

  const block = await db.courtBlock.findFirst({
    where: {
      courtId,
      startAt: { lt: endAt },
      endAt: { gt: startAt }
    }
  });

  const startParts = getSaoPauloDateParts(startAt);
  const endParts = getSaoPauloDateParts(endAt);
  const permanentBlock = await db.permanentCourtBlock.findFirst({
    where: {
      courtId,
      active: true,
      dayOfWeek: startParts.dayOfWeek,
      startMinutes: { lt: endParts.minutes },
      endMinutes: { gt: startParts.minutes }
    }
  });

  if (conflict || block || permanentBlock) throw new Error("Horário indisponível para esta quadra.");
}

async function assertNoFutureReservationConflictForPermanentBlock(courtId: string, dayOfWeek: number, startMinutes: number, endMinutes: number) {
  const reservations = await prisma.reservation.findMany({
    where: {
      courtId,
      status: { in: [ReservationStatus.PENDING_PAYMENT, ReservationStatus.CONFIRMED] },
      endAt: { gt: new Date() }
    },
    select: { id: true, startAt: true, endAt: true },
    take: 1000
  });
  const conflict = reservations.find((reservation) => {
    const start = getSaoPauloDateParts(reservation.startAt);
    const end = getSaoPauloDateParts(reservation.endAt);
    return start.dayOfWeek === dayOfWeek && start.minutes < endMinutes && end.minutes > startMinutes;
  });
  if (conflict) throw new Error("Existe reserva futura conflitante com esse horario permanente.");
}

async function expireOldReservations() {
  await prisma.reservation.updateMany({
    where: {
      status: ReservationStatus.PENDING_PAYMENT,
      expiresAt: { lt: new Date() }
    },
    data: { status: ReservationStatus.EXPIRED }
  });
  await prisma.payment.updateMany({
    where: {
      status: PaymentStatus.PENDING,
      reservation: { status: ReservationStatus.EXPIRED }
    },
    data: { status: PaymentStatus.CANCELLED }
  });
}

async function syncMercadoPagoPayment(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { reservation: { include: { court: true, user: true } } }
  });
  if (!payment) throw new Error("Pagamento não encontrado.");
  if (payment.status !== PaymentStatus.PENDING || !payment.providerPaymentId || !isMercadoPagoProvider(payment.provider)) {
    return payment;
  }

  const mercadoPagoPayment = await getMercadoPagoPayment(payment.providerPaymentId);
  const paidAmountCents = centsFromMercadoPagoAmount(mercadoPagoPayment.transaction_amount);
  const referenceMatches = mercadoPagoPayment.external_reference === payment.reservationId
    || mercadoPagoPayment.metadata?.reservation_id === payment.reservationId;
  const amountMatches = paidAmountCents === payment.amountCents;
  const approvedAt = mercadoPagoPayment.date_approved ? new Date(mercadoPagoPayment.date_approved) : null;
  const paidAfterExpiration = Boolean(
    mercadoPagoPayment.status === "approved"
    && payment.pixExpiresAt
    && approvedAt
    && approvedAt.getTime() > payment.pixExpiresAt.getTime()
  );
  const nextPaymentStatus = mercadoPagoPayment.status === "approved"
    ? (referenceMatches && amountMatches && !paidAfterExpiration ? PaymentStatus.PAID : PaymentStatus.FAILED)
    : mercadoPagoPayment.status === "cancelled"
      ? PaymentStatus.CANCELLED
      : mercadoPagoPayment.status === "refunded"
        ? PaymentStatus.REFUNDED
        : ["rejected", "charged_back"].includes(mercadoPagoPayment.status)
        ? PaymentStatus.FAILED
        : PaymentStatus.PENDING;

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.payment.findUnique({
      where: { id: payment.id },
      include: { reservation: true }
    });
    if (!current || current.status !== PaymentStatus.PENDING) return current ?? payment;

    const nextReservationStatus = nextPaymentStatus === PaymentStatus.PAID
      ? ReservationStatus.CONFIRMED
      : nextPaymentStatus === PaymentStatus.REFUNDED
        ? ReservationStatus.REFUNDED
        : nextPaymentStatus === PaymentStatus.CANCELLED || nextPaymentStatus === PaymentStatus.FAILED
          ? ReservationStatus.FAILED
          : current.reservation.status;

    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: nextPaymentStatus,
        paidAt: nextPaymentStatus === PaymentStatus.PAID ? (approvedAt ?? new Date()) : current.paidAt,
        rawPayload: {
          ...(current.rawPayload && typeof current.rawPayload === "object" && !Array.isArray(current.rawPayload) ? current.rawPayload : {}),
          mercadoPagoPayment,
          validation: {
            referenceMatches,
            amountMatches,
            paidAfterExpiration,
            expectedAmountCents: current.amountCents,
            paidAmountCents
          }
        }
      }
    });

    if (current.reservation.status === ReservationStatus.PENDING_PAYMENT && nextReservationStatus !== current.reservation.status) {
      await tx.reservation.update({
        where: { id: current.reservationId },
        data: { status: nextReservationStatus }
      });
    }

    await writeAuditLog({
      action: "payment.sync",
      entityType: "Payment",
      entityId: payment.id,
      metadata: {
        provider: "mercado_pago",
        providerPaymentId: payment.providerPaymentId,
        nextPaymentStatus,
        referenceMatches,
        amountMatches,
        paidAfterExpiration
      }
    }, tx);

    return updatedPayment;
  });

  if (updated?.status === PaymentStatus.PAID) {
    const reservation = await prisma.reservation.findUnique({
      where: { id: payment.reservationId },
      include: { court: true, user: true }
    });
    if (reservation?.status === ReservationStatus.CONFIRMED) {
      await logWhatsApp(WhatsAppEvent.PAYMENT_CONFIRMED, reservation);
    }
  }

  return updated;
}

async function syncPendingMercadoPagoPayments() {
  const pending = await prisma.payment.findMany({
    where: {
      status: PaymentStatus.PENDING,
      provider: { contains: "mercado_pago" }
    },
    select: { id: true },
    take: 25
  });

  for (const payment of pending) {
    try {
      await syncMercadoPagoPayment(payment.id);
    } catch {
      undefined;
    }
  }
}

async function ensureDatabaseGuards() {
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reservation_no_active_overlap'
      ) THEN
        ALTER TABLE "Reservation"
        ADD CONSTRAINT reservation_no_active_overlap
        EXCLUDE USING gist (
          "courtId" WITH =,
          tsrange("startAt", "endAt", '[)') WITH &&
        )
        WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED'));
      END IF;
    END $$;
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'court_block_no_overlap'
      ) THEN
        ALTER TABLE "CourtBlock"
        ADD CONSTRAINT court_block_no_overlap
        EXCLUDE USING gist (
          "courtId" WITH =,
          tsrange("startAt", "endAt", '[)') WITH &&
        );
      END IF;
    END $$;
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'permanent_block_no_overlap'
      ) THEN
        ALTER TABLE "PermanentCourtBlock"
        ADD CONSTRAINT permanent_block_no_overlap
        EXCLUDE USING gist (
          "courtId" WITH =,
          "dayOfWeek" WITH =,
          int4range("startMinutes", "endMinutes", '[)') WITH &&
        )
        WHERE (active = true);
      END IF;
    END $$;
  `);
}

function promoMatches(price: {
  twoHourPromoCents: number | null;
  promoActive?: boolean | null;
  promoDays?: string | null;
  promoStartMinutes?: number | null;
  promoEndMinutes?: number | null;
}, startAt?: Date) {
  if (!price.twoHourPromoCents || price.promoActive === false) return false;
  if (!startAt) return true;
  const parts = getSaoPauloDateParts(startAt);
  const days = price.promoDays?.split(",").map((item) => Number(item)).filter(Number.isInteger) ?? [];
  if (days.length && !days.includes(parts.dayOfWeek)) return false;
  if (price.promoStartMinutes !== null && price.promoStartMinutes !== undefined && parts.minutes < price.promoStartMinutes) return false;
  if (price.promoEndMinutes !== null && price.promoEndMinutes !== undefined && parts.minutes >= price.promoEndMinutes) return false;
  return true;
}

function applyPromoRules<T extends {
  hourlyPriceCents: number;
  twoHourPromoCents: number | null;
  promoActive?: boolean | null;
  promoDays?: string | null;
  promoStartMinutes?: number | null;
  promoEndMinutes?: number | null;
}>(price: T | null | undefined, startAt?: Date) {
  if (!price) return null;
  return {
    ...price,
    twoHourPromoCents: promoMatches(price, startAt) ? price.twoHourPromoCents : null
  };
}

async function getCourtPrice(courtId: string, sport: string, court?: { type: string }, startAt?: Date) {
  const rows = await prisma.$queryRaw<Array<{ hourlyPriceCents: number; twoHourPromoCents: number | null; promoActive: boolean; promoDays: string | null; promoStartMinutes: number | null; promoEndMinutes: number | null }>>`
    SELECT "hourlyPriceCents", "twoHourPromoCents", "promoActive", "promoDays", "promoStartMinutes", "promoEndMinutes"
    FROM "CourtPrice"
    WHERE "courtId" = ${courtId} AND "sport" = ${sport} AND "active" = true
    LIMIT 1
  `;
  if (rows[0]) return applyPromoRules(rows[0], startAt);
  if (court?.type !== "SAND_VOLLEY") return null;

  const sandRows = await prisma.$queryRaw<Array<{ hourlyPriceCents: number; twoHourPromoCents: number | null; promoActive: boolean; promoDays: string | null; promoStartMinutes: number | null; promoEndMinutes: number | null }>>`
    SELECT p."hourlyPriceCents", p."twoHourPromoCents", p."promoActive", p."promoDays", p."promoStartMinutes", p."promoEndMinutes"
    FROM "CourtPrice" p
    INNER JOIN "Court" c ON c."id" = p."courtId"
    WHERE c."type" = 'SAND_VOLLEY' AND p."sport" = ${sport} AND p."active" = true
    ORDER BY p."updatedAt" DESC
    LIMIT 1
  `;
  return applyPromoRules(sandRows[0], startAt);
}

async function getAllCourtPrices() {
  return prisma.$queryRaw<Array<{
    courtId: string;
    sport: string;
    hourlyPriceCents: number;
    twoHourPromoCents: number | null;
    promoActive: boolean;
    promoDays: string | null;
    promoStartMinutes: number | null;
    promoEndMinutes: number | null;
    active: boolean;
  }>>`
    SELECT "courtId", "sport", "hourlyPriceCents", "twoHourPromoCents", "promoActive", "promoDays", "promoStartMinutes", "promoEndMinutes", "active"
    FROM "CourtPrice"
  `;
}

function findSavedPrice(court: { id: string; type: string }, sport: string, prices: Array<{
  courtId: string;
  sport: string;
  hourlyPriceCents: number;
  twoHourPromoCents: number | null;
  promoActive: boolean;
  promoDays: string | null;
  promoStartMinutes: number | null;
  promoEndMinutes: number | null;
  active: boolean;
}>) {
  return prices.find((item) => item.courtId === court.id && item.sport === sport)
    ?? (court.type === "SAND_VOLLEY" ? prices.find((item) => item.sport === sport) : undefined);
}

export async function registerRoutes(app: FastifyInstance) {
  await ensureDatabaseGuards();
  const paymentSyncTimer = setInterval(() => {
    void syncPendingMercadoPagoPayments();
  }, 60_000);
  app.addHook("onClose", async () => clearInterval(paymentSyncTimer));

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/public/content", async () => {
    const courts = await prisma.court.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    const prices = await getAllCourtPrices();
    return {
      assets: siteAssets,
      teams: teamPages,
      prices: courts.flatMap((court) => court.sports.map((sport) => {
        const saved = findSavedPrice(court, sport, prices);
        const fallback = getFallbackPriceConfig(court, sport);
        return {
          courtId: court.id,
          courtName: court.name,
          sport,
          hourlyPriceCents: saved?.hourlyPriceCents ?? fallback.hourlyPriceCents,
          twoHourPromoCents: saved?.twoHourPromoCents ?? fallback.twoHourPromoCents,
          promoActive: saved?.promoActive ?? true,
          promoDays: saved?.promoDays ?? null,
          promoStartMinutes: saved?.promoStartMinutes ?? null,
          promoEndMinutes: saved?.promoEndMinutes ?? null
        };
      })),
      links: {
        whatsapp: "https://wa.me/5553984736130",
        instagram: "https://www.instagram.com/arenaepv/",
        maps: "https://maps.app.goo.gl/wgxMEA9jJwuESV7o6",
        meuLance: "https://meulance.net.br/login"
      },
      address: "Avenida Visconde de Jaguari 164, Pelotas - RS, 96010-530"
    };
  });

  app.post("/api/auth/register", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      fullName: z.string().min(3)
    }).parse(request.body);

    const passwordHash = await bcrypt.hash(body.password, 12);
    try {
      const user = await prisma.user.create({
        data: {
          email: body.email.toLowerCase(),
          fullName: body.fullName,
          passwordHash,
          role: Role.CLIENT
        },
        select: publicUser
      });
      return { user, token: signToken(user) };
    } catch (error) {
      request.log.error(error);
      return reply.code(409).send({ message: "Este email já está cadastrado ou o cadastro não pôde ser criado." });
    }
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = z.object({
      email: z.string().min(3),
      password: z.string()
    }).parse(request.body);

    const loginAliases: Record<string, string> = {
      vinicius: "vinicius@arenaepv.local",
      sabrina: "sabrina@arenaepv.local",
      recepcao: "recepcao@arenaepv.local",
      recepção: "recepcao@arenaepv.local"
    };
    const identifier = body.email.toLowerCase().trim();
    const email = loginAliases[normalizeText(identifier)] ?? identifier;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      return reply.code(401).send({ message: "Email ou senha inválidos." });
    }

    const payload = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      mustChangePass: user.mustChangePass
    };
    return { user: payload, token: signToken(payload) };
  });

  app.post("/api/auth/change-password", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({
      currentPassword: z.string().optional(),
      password: z.string().min(6)
    }).parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.id } });
    if (!user.mustChangePass) {
      if (!body.currentPassword || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
        return reply.code(400).send({ message: "Senha atual incorreta." });
      }
    }
    await prisma.user.update({
      where: { id: request.user.id },
      data: { passwordHash: await bcrypt.hash(body.password, 12), mustChangePass: false }
    });
    return { ok: true };
  });

  app.get("/api/courts", async () => prisma.court.findMany({ where: { active: true }, orderBy: { name: "asc" } }));

  app.get("/api/reservations/availability", async (request) => {
    await expireOldReservations();
    const query = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      sport: z.string().optional(),
      slotMinutes: z.coerce.number().int().refine((value) => value === 30 || value === 60).optional()
    }).parse(request.query);

    const { dayStart, dayEnd } = localDayRange(query.date);
    const dayOfWeek = getSaoPauloDateParts(dayStart).dayOfWeek;
    const slotMinutes = query.slotMinutes ?? 60;
    const courts = await prisma.court.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    const reservations = await prisma.reservation.findMany({
      where: {
        status: { in: [ReservationStatus.PENDING_PAYMENT, ReservationStatus.CONFIRMED] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        startAt: { lt: dayEnd },
        endAt: { gt: dayStart }
      }
    });
    const blocks = await prisma.courtBlock.findMany({
      where: {
        startAt: { lt: dayEnd },
        endAt: { gt: dayStart }
      }
    });
    const permanentBlocks = await prisma.permanentCourtBlock.findMany({
      where: {
        active: true,
        dayOfWeek
      }
    });

    const slots = Array.from({ length: (14 * 60) / slotMinutes }, (_, index) => 8 * 60 + index * slotMinutes);
    const normalizedSport = query.sport ? normalizeText(query.sport) : "";
    const rows = slots.map((startMinutes) => {
      const endMinutes = startMinutes + slotMinutes;
      const startAt = addMinutes(dayStart, startMinutes);
      const endAt = addMinutes(dayStart, endMinutes);
      return {
        hour: startMinutes,
        startMinutes,
        endMinutes,
        label: `${minutesToLabel(startMinutes)} - ${minutesToLabel(endMinutes)}`,
        courts: courts.map((court) => {
          const supportsSport = !normalizedSport || court.sports.some((sport) => normalizeText(sport) === normalizedSport);
          const reservation = reservations.find((item) => item.courtId === court.id && item.startAt < endAt && item.endAt > startAt);
          const reserved = Boolean(reservation);
          const blocked = blocks.some((item) => item.courtId === court.id && item.startAt < endAt && item.endAt > startAt);
          const permanentBlocked = permanentBlocks.some((item) => (
            item.courtId === court.id &&
            item.startMinutes < endMinutes &&
            item.endMinutes > startMinutes
          ));
          return {
            courtId: court.id,
            available: supportsSport && !reserved && !blocked && !permanentBlocked && startAt.getTime() > Date.now(),
            reserved,
            pendingPayment: reservation?.status === ReservationStatus.PENDING_PAYMENT,
            blocked: blocked || permanentBlocked,
            permanentBlocked,
            supportsSport
          };
        })
      };
    });

    return { date: query.date, hours: rows };
  });

  app.post("/api/reservations/quote", async (request) => {
    const body = z.object({
      courtId: z.string(),
      sport: z.string(),
      startAt: z.string().datetime().optional(),
      durationHours: z.number().min(1).optional(),
      durationMinutes: z.number().int().min(60).optional()
    }).parse(request.body);
    const court = await prisma.court.findUniqueOrThrow({ where: { id: body.courtId } });
    const durationMinutes = body.durationMinutes ?? (body.durationHours ?? 1) * 60;
    ensureReservationDuration(durationMinutes);
    const durationHours = durationMinutes / 60;
    if (!court.sports.some((sport) => normalizeText(sport) === normalizeText(body.sport))) {
      return { amountCents: 0, unavailable: true };
    }
    const startAt = body.startAt ? new Date(body.startAt) : undefined;
    const price = await getCourtPrice(body.courtId, body.sport, court, startAt);
    return { amountCents: calculatePriceCents(court, body.sport, durationHours, price) };
  });

  app.post("/api/reservations", { preHandler: requireAuth }, async (request, reply) => {
    await expireOldReservations();
    const body = z.object({
      courtId: z.string(),
      startAt: z.string().datetime(),
      durationHours: z.number().min(1).optional(),
      durationMinutes: z.number().int().min(60).optional(),
      sport: z.string().min(3)
    }).parse(request.body);

    const startAt = new Date(body.startAt);
    const durationMinutes = body.durationMinutes ?? (body.durationHours ?? 1) * 60;
    ensureReservationDuration(durationMinutes);
    const durationHours = durationMinutes / 60;
    const endAt = addMinutes(startAt, durationMinutes);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    ensureOperatingHours(startAt, endAt);

    const court = await prisma.court.findUniqueOrThrow({ where: { id: body.courtId } });
    if (!court.sports.some((sport) => normalizeText(sport) === normalizeText(body.sport))) {
      return reply.code(400).send({ message: "Modalidade indisponível para esta quadra." });
    }

    const price = await getCourtPrice(body.courtId, body.sport, court, startAt);
    const amountCents = calculatePriceCents(court, body.sport, durationHours, price);

    const reservation = await prisma.$transaction(async (tx) => {
      await assertNoConflict(body.courtId, startAt, endAt, undefined, tx);
      return tx.reservation.create({
        data: {
          courtId: body.courtId,
          userId: request.user.id,
          startAt,
          endAt,
          expiresAt,
          durationHours: Math.ceil(durationHours),
          sport: body.sport,
          amountCents,
          createdByRole: request.user.role
        },
        include: { court: true, user: true }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    let pix;
    try {
      pix = await createPixPayment(reservation);
    } catch (error) {
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.EXPIRED }
      });
      throw error;
    }
    const payment = await prisma.payment.create({
      data: {
        reservationId: reservation.id,
        amountCents,
        ...pix
      }
    });
    const whatsapp = await logWhatsApp(WhatsAppEvent.PENDING_PAYMENT, reservation);

    return reply.code(201).send({ reservation, payment, whatsapp });
  });

  app.post("/api/reservations/batch", { preHandler: requireAuth }, async (request, reply) => {
    await expireOldReservations();
    const body = z.object({
      items: z.array(z.object({
        courtId: z.string(),
        startAt: z.string().datetime(),
        durationHours: z.number().min(1).optional(),
        durationMinutes: z.number().int().min(60).optional(),
        sport: z.string().min(3)
      })).min(1).max(12)
    }).parse(request.body);

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const created: { reservation: any; payment: any; whatsapp: any }[] = [];
    assertNoInternalBatchConflict(body.items.map((item) => {
      const startAt = new Date(item.startAt);
      const durationMinutes = item.durationMinutes ?? (item.durationHours ?? 1) * 60;
      return {
        courtId: item.courtId,
        startAt,
        endAt: addMinutes(startAt, durationMinutes)
      };
    }));

    for (const item of body.items) {
      const startAt = new Date(item.startAt);
      const durationMinutes = item.durationMinutes ?? (item.durationHours ?? 1) * 60;
      ensureReservationDuration(durationMinutes);
      const durationHours = durationMinutes / 60;
      const endAt = addMinutes(startAt, durationMinutes);
      ensureOperatingHours(startAt, endAt);

      const court = await prisma.court.findUniqueOrThrow({ where: { id: item.courtId } });
      if (!court.sports.some((sport) => normalizeText(sport) === normalizeText(item.sport))) {
        return reply.code(400).send({ message: `Modalidade indisponível para ${court.name}.` });
      }

      const price = await getCourtPrice(item.courtId, item.sport, court, startAt);
      const amountCents = calculatePriceCents(court, item.sport, durationHours, price);
      const reservation = await prisma.$transaction(async (tx) => {
        await assertNoConflict(item.courtId, startAt, endAt, undefined, tx);
        return tx.reservation.create({
          data: {
            courtId: item.courtId,
            userId: request.user.id,
            startAt,
            endAt,
            expiresAt,
            durationHours: Math.ceil(durationHours),
            sport: item.sport,
            amountCents,
            createdByRole: request.user.role
          },
          include: { court: true, user: true }
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      let pix;
      try {
        pix = await createPixPayment(reservation);
      } catch (error) {
        await prisma.reservation.updateMany({
          where: { id: { in: [reservation.id, ...created.map((item) => item.reservation.id)] } },
          data: { status: ReservationStatus.EXPIRED }
        });
        await prisma.payment.updateMany({
          where: { reservationId: { in: created.map((item) => item.reservation.id) } },
          data: { status: PaymentStatus.CANCELLED }
        });
        throw error;
      }
      const payment = await prisma.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents,
          ...pix
        }
      });
      const whatsapp = await logWhatsApp(WhatsAppEvent.PENDING_PAYMENT, reservation);
      created.push({ reservation, payment, whatsapp });
    }

    return reply.code(201).send({
      reservations: created.map((item) => item.reservation),
      payments: created.map((item) => item.payment),
      whatsapps: created.map((item) => item.whatsapp),
      amountCents: created.reduce((total, item) => total + item.reservation.amountCents, 0)
    });
  });

  app.get("/api/me/reservations", { preHandler: requireAuth }, async (request) => {
    await expireOldReservations();
    return prisma.reservation.findMany({
      where: {
        userId: request.user.id,
        status: { in: [ReservationStatus.PENDING_PAYMENT, ReservationStatus.CONFIRMED] },
        endAt: { gte: new Date() }
      },
      include: { court: true, payment: true, whatsappLogs: { orderBy: { createdAt: "desc" } } },
      orderBy: { startAt: "asc" }
    });
  });

  app.post("/api/reservations/:id/cancel", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: { court: true, user: true }
    });
    if (!reservation) return reply.code(404).send({ message: "Reserva não encontrada." });
    const canManage = request.user.role === Role.ADMIN || request.user.role === Role.RECEPTION;
    if (!canManage && reservation.userId !== request.user.id) return reply.code(403).send({ message: "Permissão insuficiente." });

    const hoursUntil = (reservation.startAt.getTime() - Date.now()) / 36e5;
    if (!canManage && hoursUntil < 48) {
      return reply.code(400).send({ message: "Cancelamento permitido somente com 48h de antecedência." });
    }

    const updated = await prisma.reservation.update({
      where: { id },
      data: {
        status: ReservationStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: "Cancelado pelo usuário. Reembolso tratado via WhatsApp."
      },
      include: { court: true, user: true, payment: true }
    });
    await prisma.payment.updateMany({ where: { reservationId: id }, data: { status: PaymentStatus.REFUNDED_MANUAL } });
    const whatsapp = await logWhatsApp(WhatsAppEvent.CANCELLATION, reservation);
    return { reservation: updated, whatsapp };
  });

  app.get("/api/admin/reservations", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async () => {
    await expireOldReservations();
    return prisma.reservation.findMany({
      include: { court: true, user: true, payment: true },
      orderBy: { startAt: "desc" },
      take: 300
    });
  });

  app.post("/api/admin/reservations", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request, reply) => {
    await expireOldReservations();
    const body = z.object({
      courtId: z.string(),
      startAt: z.string().datetime(),
      durationMinutes: z.number().int().min(60).optional(),
      sport: z.string().min(3),
      guestName: z.string().min(2).max(80).optional()
    }).parse(request.body);

    const startAt = new Date(body.startAt);
    const durationMinutes = body.durationMinutes ?? 60;
    ensureReservationDuration(durationMinutes);
    const durationHours = durationMinutes / 60;
    const endAt = addMinutes(startAt, durationMinutes);
    ensureOperatingHours(startAt, endAt);

    const court = await prisma.court.findUniqueOrThrow({ where: { id: body.courtId } });
    if (!court.sports.some((sport) => normalizeText(sport) === normalizeText(body.sport))) {
      return reply.code(400).send({ message: "Modalidade indisponível para esta quadra." });
    }

    const price = await getCourtPrice(body.courtId, body.sport, court, startAt);
    const amountCents = calculatePriceCents(court, body.sport, durationHours, price);
    const reservation = await prisma.$transaction(async (tx) => {
      await assertNoConflict(body.courtId, startAt, endAt, undefined, tx);
      return tx.reservation.create({
        data: {
          courtId: body.courtId,
          userId: null,
          guestName: body.guestName ?? `Marcado por ${request.user.fullName}`,
          startAt,
          endAt,
          expiresAt: null,
          durationHours: Math.ceil(durationHours),
          sport: body.sport,
          amountCents,
          status: ReservationStatus.CONFIRMED,
          createdByRole: request.user.role
        },
        include: { court: true, user: true, payment: true }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return reply.code(201).send(reservation);
  });

  app.post("/api/admin/reservations/:id/payment", { preHandler: requireRole([Role.ADMIN]) }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ status: z.nativeEnum(PaymentStatus) }).parse(request.body);
    const existingPayment = await prisma.payment.findUnique({ where: { reservationId: id } });
    if (existingPayment && body.status === PaymentStatus.PAID && isMercadoPagoProvider(existingPayment.provider)) {
      return reply.code(400).send({ message: "Pagamentos Mercado Pago so podem ser confirmados por consulta segura ao provedor." });
    }
    if (!existingPayment) return reply.code(404).send({ message: "Pagamento não encontrado para esta reserva." });

    const payment = await prisma.payment.update({
      where: { reservationId: id },
      data: { status: body.status, paidAt: body.status === PaymentStatus.PAID ? new Date() : null }
    });
    const reservation = await prisma.reservation.update({
      where: { id },
      data: { status: body.status === PaymentStatus.PAID ? ReservationStatus.CONFIRMED : ReservationStatus.PENDING_PAYMENT },
      include: { court: true, user: true }
    });
    await writeAuditLog({
      actorId: request.user.id,
      action: "admin.payment.update",
      entityType: "Reservation",
      entityId: id,
      metadata: { status: body.status }
    });
    if (body.status === PaymentStatus.PAID) await logWhatsApp(WhatsAppEvent.PAYMENT_CONFIRMED, reservation);
    return { reservation, payment };
  });

  app.post("/api/admin/reservations/:id/remove-slot", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      startAt: z.string().datetime(),
      endAt: z.string().datetime()
    }).parse(request.body);

    const slotStart = new Date(body.startAt);
    const slotEnd = new Date(body.endAt);
    if (slotEnd <= slotStart) return reply.code(400).send({ message: "Horário inválido para remover." });

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: { court: true, user: true, payment: true }
    });
    if (!reservation) return reply.code(404).send({ message: "Reserva não encontrada." });
    if (reservation.status !== ReservationStatus.PENDING_PAYMENT && reservation.status !== ReservationStatus.CONFIRMED) {
      return reply.code(400).send({ message: "Só é possível remover horários de reservas ativas." });
    }
    if (slotStart < reservation.startAt || slotEnd > reservation.endAt) {
      return reply.code(400).send({ message: "Esse horário não pertence à reserva selecionada." });
    }

    const price = await getCourtPrice(reservation.courtId, reservation.sport, reservation.court, reservation.startAt);
    const amountForRange = (start: Date, end: Date) => {
      const durationHours = (end.getTime() - start.getTime()) / 36e5;
      if (durationHours < 1) {
        const hourlyPriceCents = price?.hourlyPriceCents ?? (reservation.sport.toLowerCase().includes("futsal") ? 12000 : reservation.court.type === "SAND_VOLLEY" ? 6000 : 10000);
        return Math.round(hourlyPriceCents * durationHours);
      }
      return calculatePriceCents(reservation.court, reservation.sport, durationHours, price);
    };

    if (slotStart.getTime() <= reservation.startAt.getTime() && slotEnd.getTime() >= reservation.endAt.getTime()) {
      const updated = await prisma.reservation.update({
        where: { id },
        data: {
          status: ReservationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: "Horário removido pelo painel administrativo."
        },
        include: { court: true, user: true, payment: true }
      });
      await prisma.payment.updateMany({ where: { reservationId: id }, data: { status: PaymentStatus.REFUNDED_MANUAL } });
      return { reservation: updated, removed: "full" };
    }

    if (slotStart.getTime() <= reservation.startAt.getTime()) {
      const amountCents = amountForRange(slotEnd, reservation.endAt);
      const updated = await prisma.reservation.update({
        where: { id },
        data: {
          startAt: slotEnd,
          durationHours: Math.ceil((reservation.endAt.getTime() - slotEnd.getTime()) / 36e5),
          amountCents
        },
        include: { court: true, user: true, payment: true }
      });
      await prisma.payment.updateMany({ where: { reservationId: id }, data: { amountCents } });
      return { reservation: updated, removed: "start" };
    }

    if (slotEnd.getTime() >= reservation.endAt.getTime()) {
      const amountCents = amountForRange(reservation.startAt, slotStart);
      const updated = await prisma.reservation.update({
        where: { id },
        data: {
          endAt: slotStart,
          durationHours: Math.ceil((slotStart.getTime() - reservation.startAt.getTime()) / 36e5),
          amountCents
        },
        include: { court: true, user: true, payment: true }
      });
      await prisma.payment.updateMany({ where: { reservationId: id }, data: { amountCents } });
      return { reservation: updated, removed: "end" };
    }

    const amountBefore = amountForRange(reservation.startAt, slotStart);
    const amountAfter = amountForRange(slotEnd, reservation.endAt);
    const [updated, created] = await prisma.$transaction(async (tx) => {
      const before = await tx.reservation.update({
        where: { id },
        data: {
          endAt: slotStart,
          durationHours: Math.ceil((slotStart.getTime() - reservation.startAt.getTime()) / 36e5),
          amountCents: amountBefore
        },
        include: { court: true, user: true, payment: true }
      });
      await tx.payment.updateMany({ where: { reservationId: id }, data: { amountCents: amountBefore } });
      const after = await tx.reservation.create({
        data: {
          courtId: reservation.courtId,
          userId: reservation.userId,
          guestName: reservation.guestName,
          startAt: slotEnd,
          endAt: reservation.endAt,
          expiresAt: reservation.expiresAt,
          durationHours: Math.ceil((reservation.endAt.getTime() - slotEnd.getTime()) / 36e5),
          sport: reservation.sport,
          amountCents: amountAfter,
          status: reservation.status,
          createdByRole: reservation.createdByRole
        },
        include: { court: true, user: true, payment: true }
      });
      if (reservation.payment) {
        await tx.payment.create({
          data: {
            reservationId: after.id,
            provider: `${reservation.payment.provider}_split`,
            providerPaymentId: reservation.payment.providerPaymentId ? `${reservation.payment.providerPaymentId}_split_${after.id.slice(0, 6)}` : null,
            status: reservation.payment.status,
            amountCents: amountAfter,
            pixQrCode: reservation.payment.pixQrCode,
            pixQrCodeBase64: reservation.payment.pixQrCodeBase64,
            pixExpiresAt: reservation.payment.pixExpiresAt,
            paidAt: reservation.payment.paidAt,
            rawPayload: { splitFromReservationId: id }
          }
        });
      }
      return [before, after];
    });
    return { reservation: updated, createdReservation: created, removed: "middle" };
  });

  app.post("/api/admin/blocks", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request) => {
    const body = z.object({
      courtId: z.string(),
      startAt: z.string().datetime(),
      endAt: z.string().datetime(),
      reason: z.string().min(3)
    }).parse(request.body);
    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);
    await assertNoConflict(body.courtId, startAt, endAt);
    return prisma.courtBlock.create({ data: { ...body, startAt, endAt } });
  });

  app.get("/api/admin/users", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async () => (
    prisma.user.findMany({
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
        _count: { select: { reservations: true } }
      },
      orderBy: [{ role: "asc" }, { fullName: "asc" }]
    })
  ));

  app.get("/api/admin/users/:id/reservations", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return prisma.reservation.findMany({
      where: { userId: id },
      include: { court: true, user: true, payment: true },
      orderBy: { startAt: "desc" },
      take: 500
    });
  });

  app.patch("/api/admin/users/:id/role", { preHandler: requireRole([Role.ADMIN]) }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ role: z.nativeEnum(Role) }).parse(request.body);
    if (id === request.user.id && body.role !== Role.ADMIN) {
      return reply.code(400).send({ message: "Você não pode remover o próprio cargo de admin." });
    }
    return prisma.user.update({
      where: { id },
      data: { role: body.role },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
        _count: { select: { reservations: true } }
      }
    });
  });

  app.get("/api/admin/financial", { preHandler: requireRole([Role.ADMIN]) }, async () => {
    const ranges = [1, 7, 14, 30, 60, 90];
    const now = Date.now();
    const results = await Promise.all(ranges.map(async (days) => {
      const since = new Date(now - days * 24 * 60 * 60 * 1000);
      const paid = await prisma.payment.findMany({
        where: { status: PaymentStatus.PAID, paidAt: { gte: since } },
        select: { amountCents: true, provider: true }
      });
      return {
        days,
        amountCents: paid.reduce((total, item) => total + paymentNetCents(item), 0),
        count: paid.length
      };
    }));
    return results;
  });

  app.get("/api/admin/prices", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async () => {
    const courts = await prisma.court.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    const prices = await getAllCourtPrices();
    return courts.flatMap((court) => court.sports.map((sport) => {
      const saved = findSavedPrice(court, sport, prices);
      const fallback = getFallbackPriceConfig(court, sport);
      return {
        courtId: court.id,
        courtName: court.name,
        sport,
        hourlyPriceCents: saved?.hourlyPriceCents ?? fallback.hourlyPriceCents,
        twoHourPromoCents: saved?.twoHourPromoCents ?? fallback.twoHourPromoCents,
        promoActive: saved?.promoActive ?? true,
        promoDays: saved?.promoDays ?? null,
        promoStartMinutes: saved?.promoStartMinutes ?? null,
        promoEndMinutes: saved?.promoEndMinutes ?? null,
        active: saved?.active ?? true
      };
    }));
  });

  app.put("/api/admin/prices", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request, reply) => {
    const body = z.object({
      courtId: z.string(),
      sport: z.string().min(3),
      hourlyPriceCents: z.number().int().min(0),
      twoHourPromoCents: z.number().int().min(0).nullable().optional(),
      promoActive: z.boolean().optional(),
      promoDays: z.array(z.number().int().min(0).max(6)).optional(),
      promoStartMinutes: z.number().int().min(0).max(1439).nullable().optional(),
      promoEndMinutes: z.number().int().min(1).max(1440).nullable().optional()
    }).parse(request.body);
    if (body.promoStartMinutes !== null && body.promoStartMinutes !== undefined && body.promoEndMinutes !== null && body.promoEndMinutes !== undefined && body.promoEndMinutes <= body.promoStartMinutes) {
      return reply.code(400).send({ message: "O fim da promoção precisa ser depois do início." });
    }

    const id = `price_${crypto.randomUUID()}`;
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      courtId: string;
      sport: string;
      hourlyPriceCents: number;
      twoHourPromoCents: number | null;
      promoActive: boolean;
      promoDays: string | null;
      promoStartMinutes: number | null;
      promoEndMinutes: number | null;
      active: boolean;
    }>>`
      INSERT INTO "CourtPrice" ("id", "courtId", "sport", "hourlyPriceCents", "twoHourPromoCents", "promoActive", "promoDays", "promoStartMinutes", "promoEndMinutes", "active", "createdAt", "updatedAt")
      VALUES (${id}, ${body.courtId}, ${body.sport}, ${body.hourlyPriceCents}, ${body.twoHourPromoCents ?? null}, ${body.promoActive ?? true}, ${body.promoDays?.join(",") ?? null}, ${body.promoStartMinutes ?? null}, ${body.promoEndMinutes ?? null}, true, NOW(), NOW())
      ON CONFLICT ("courtId", "sport")
      DO UPDATE SET
        "hourlyPriceCents" = EXCLUDED."hourlyPriceCents",
        "twoHourPromoCents" = EXCLUDED."twoHourPromoCents",
        "promoActive" = EXCLUDED."promoActive",
        "promoDays" = EXCLUDED."promoDays",
        "promoStartMinutes" = EXCLUDED."promoStartMinutes",
        "promoEndMinutes" = EXCLUDED."promoEndMinutes",
        "active" = true,
        "updatedAt" = NOW()
      RETURNING "id", "courtId", "sport", "hourlyPriceCents", "twoHourPromoCents", "promoActive", "promoDays", "promoStartMinutes", "promoEndMinutes", "active"
    `;
    return rows[0];
  });

  app.get("/api/admin/panel", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request) => {
    await expireOldReservations();
    const query = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    }).parse(request.query);
    const { dayStart, dayEnd } = localDayRange(query.date);
    const dayOfWeek = getSaoPauloDateParts(dayStart).dayOfWeek;

    const [courts, reservations, blocks, permanentBlocks] = await Promise.all([
      prisma.court.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
      prisma.reservation.findMany({
        where: {
          startAt: { lt: dayEnd },
          endAt: { gt: dayStart }
        },
        include: { court: true, user: true, payment: true },
        orderBy: { startAt: "asc" }
      }),
      prisma.courtBlock.findMany({
        where: {
          startAt: { lt: dayEnd },
          endAt: { gt: dayStart }
        },
        include: { court: true },
        orderBy: { startAt: "asc" }
      }),
      prisma.permanentCourtBlock.findMany({
        where: { active: true, dayOfWeek },
        include: { court: true },
        orderBy: [{ startMinutes: "asc" }, { court: { name: "asc" } }]
      })
    ]);

    const slots = Array.from({ length: 28 }, (_, index) => {
      const startMinutes = 8 * 60 + index * 30;
      const endMinutes = startMinutes + 30;
      const startAt = addMinutes(dayStart, startMinutes);
      const endAt = addMinutes(dayStart, endMinutes);
      return {
        startMinutes,
        endMinutes,
        label: `${minutesToLabel(startMinutes)} - ${minutesToLabel(endMinutes)}`,
        courts: courts.map((court) => {
          const reservation = reservations.find((item) => (
            item.courtId === court.id &&
            (item.status === ReservationStatus.PENDING_PAYMENT || item.status === ReservationStatus.CONFIRMED) &&
            item.startAt < endAt &&
            item.endAt > startAt
          ));
          const block = blocks.find((item) => item.courtId === court.id && item.startAt < endAt && item.endAt > startAt);
          const permanentBlock = permanentBlocks.find((item) => (
            item.courtId === court.id &&
            item.startMinutes < endMinutes &&
            item.endMinutes > startMinutes
          ));
          return {
            courtId: court.id,
            reservationId: reservation?.id ?? null,
            blockId: block?.id ?? null,
            permanentBlockId: permanentBlock?.id ?? null,
            status: reservation ? "reserved" : block ? "blocked" : permanentBlock ? "permanent" : "free",
            title: reservation
              ? `${reservation.guestName ?? reservation.user?.fullName ?? "Cliente"} - ${reservation.sport}`
              : block?.reason ?? permanentBlock?.reason ?? "Livre",
            amountCents: reservation?.amountCents ?? 0,
            paymentStatus: reservation?.payment?.status ?? null,
            reservationStatus: reservation?.status ?? null
          };
        })
      };
    });

    const activeReservations = reservations.filter((item) => item.status === ReservationStatus.PENDING_PAYMENT || item.status === ReservationStatus.CONFIRMED);
    const confirmedReservations = reservations.filter((item) => item.status === ReservationStatus.CONFIRMED || item.payment?.status === PaymentStatus.PAID);

    return {
      date: query.date,
      courts,
      slots,
      reservations,
      blocks,
      permanentBlocks,
      summary: {
        reservations: activeReservations.length,
        estimatedRevenueCents: request.user.role === Role.ADMIN ? activeReservations.reduce((total, item) => total + reservationNetCents(item), 0) : 0,
        confirmedRevenueCents: request.user.role === Role.ADMIN ? confirmedReservations.reduce((total, item) => total + reservationNetCents(item), 0) : 0,
        permanentBlocks: permanentBlocks.length
      }
    };
  });

  app.get("/api/admin/permanent-blocks", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async () => (
    prisma.permanentCourtBlock.findMany({
      include: { court: true },
      orderBy: [{ dayOfWeek: "asc" }, { startMinutes: "asc" }]
    })
  ));

  app.post("/api/admin/permanent-blocks", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request, reply) => {
    const body = z.object({
      courtId: z.string(),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
      startTime: z.string(),
      endTime: z.string(),
      reason: z.string().min(3)
    }).parse(request.body);
    const startMinutes = parseHalfHourTime(body.startTime);
    const endMinutes = parseHalfHourTime(body.endTime);
    if (startMinutes < 8 * 60 || endMinutes > 22 * 60 || endMinutes <= startMinutes) {
      return reply.code(400).send({ message: "Horário permanente precisa ficar entre 08:00 e 22:00." });
    }

    const created = [];
    for (const dayOfWeek of body.daysOfWeek) {
      await assertNoFutureReservationConflictForPermanentBlock(body.courtId, dayOfWeek, startMinutes, endMinutes);
      const conflict = await prisma.permanentCourtBlock.findFirst({
        where: {
          courtId: body.courtId,
          dayOfWeek,
          active: true,
          startMinutes: { lt: endMinutes },
          endMinutes: { gt: startMinutes }
        }
      });
      if (conflict) return reply.code(409).send({ message: "Já existe um horário permanente conflitante para essa quadra." });
      created.push(await prisma.permanentCourtBlock.create({
        data: {
          courtId: body.courtId,
          dayOfWeek,
          startMinutes,
          endMinutes,
          reason: body.reason
        },
        include: { court: true }
      }));
    }

    return reply.code(201).send({ permanentBlocks: created });
  });

  app.patch("/api/admin/permanent-blocks/:id", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ active: z.boolean() }).parse(request.body);
    return prisma.permanentCourtBlock.update({
      where: { id },
      data: { active: body.active },
      include: { court: true }
    });
  });

  app.delete("/api/admin/permanent-blocks/:id", { preHandler: requireRole([Role.ADMIN, Role.RECEPTION]) }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.permanentCourtBlock.delete({ where: { id } });
    return { ok: true };
  });

  app.get("/api/payments/:id/check", { preHandler: requireAuth }, async (request, reply) => {
    await expireOldReservations();
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { reservation: true }
    });
    if (!payment) return reply.code(404).send({ message: "Pagamento não encontrado." });
    const canAccess = request.user.role === Role.ADMIN
      || request.user.role === Role.RECEPTION
      || payment.reservation.userId === request.user.id;
    if (!canAccess) return reply.code(403).send({ message: "Sem permissão." });

    const synced = await syncMercadoPagoPayment(id);
    return synced;
  });

  app.post("/api/webhooks/mercado-pago", async (request, reply) => {
    const body = request.body as { type?: string; data?: { id?: string } };
    const query = request.query as { id?: string; "data.id"?: string; topic?: string; type?: string };
    const providerPaymentId = body?.data?.id ?? query?.["data.id"] ?? query?.id;
    if (!providerPaymentId) return reply.code(200).send({ ok: true });

    const payment = await prisma.payment.findFirst({
      where: {
        providerPaymentId: String(providerPaymentId),
        provider: { contains: "mercado_pago" }
      }
    });
    if (!payment) return reply.code(200).send({ ok: true });

    await writeAuditLog({
      action: "payment.webhook.received",
      entityType: "Payment",
      entityId: payment.id,
      metadata: {
        provider: "mercado_pago",
        providerPaymentId: String(providerPaymentId),
        type: body?.type ?? query?.type ?? query?.topic ?? null
      }
    });
    await syncMercadoPagoPayment(payment.id);
    return { ok: true };
  });
}
