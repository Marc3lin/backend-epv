import { prisma } from "./prisma.js";
import type { Reservation, Court, User, WhatsAppEvent } from "@prisma/client";
import { formatMoney } from "./pricing.js";

const arenaPhone = "5553984736130";

export function buildWhatsAppUrl(message: string) {
  return `https://wa.me/${arenaPhone}?text=${encodeURIComponent(message)}`;
}

export async function logWhatsApp(
  event: WhatsAppEvent,
  reservation: Reservation & { court: Court; user: User | null }
) {
  const when = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo"
  }).format(reservation.startAt);

  const name = reservation.user?.fullName ?? reservation.guestName ?? "Cliente";
  const messages: Record<WhatsAppEvent, string> = {
    PENDING_PAYMENT: `Olá, Arena EPV! Sou ${name}. Acabei de criar uma reserva para ${reservation.court.name} em ${when}, no valor de ${formatMoney(reservation.amountCents)}, e estou aguardando pagamento.`,
    PAYMENT_CONFIRMED: `Olá, Arena EPV! Minha reserva para ${reservation.court.name} em ${when} foi confirmada.`,
    CANCELLATION: `Olá, Arena EPV! Cancelei minha reserva para ${reservation.court.name} em ${when}. Gostaria de tratar o reembolso pelo WhatsApp.`,
    REMINDER: `Olá, ${name}! Lembrete da sua reserva na Arena EPV: ${reservation.court.name}, ${when}.`
  };

  const message = messages[event];
  return prisma.whatsAppLog.create({
    data: {
      event,
      reservationId: reservation.id,
      message,
      redirectUrl: buildWhatsAppUrl(message)
    }
  });
}
