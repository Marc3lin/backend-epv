import crypto from "node:crypto";
import QRCode from "qrcode";
import { env } from "./env.js";
import type { Reservation, Court, User } from "@prisma/client";

type PaymentInput = Reservation & { court: Court; user: User | null };
type MercadoPagoPayment = {
  id: number | string;
  status: string;
  status_detail?: string;
  transaction_amount?: number;
  point_of_interaction?: {
    transaction_data?: {
      qr_code?: string;
      qr_code_base64?: string;
    };
  };
  date_of_expiration?: string;
};

const temporaryPixKey = "05735365037";
const temporaryPixReceiver = "ARENA EPV";
const temporaryPixCity = "PELOTAS";

export async function createPixPayment(reservation: PaymentInput) {
  if (env.PAYMENTS_MODE !== "mercado_pago" || !env.MERCADO_PAGO_ACCESS_TOKEN) {
    return createStaticPixPayment(reservation);
  }

  const response = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MERCADO_PAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": reservation.id
    },
    body: JSON.stringify({
      transaction_amount: reservation.amountCents / 100,
      description: `Reserva Arena EPV - ${reservation.court.name}`,
      payment_method_id: "pix",
      notification_url: `${env.PUBLIC_BASE_URL}/api/webhooks/mercado-pago`,
      external_reference: reservation.id,
      metadata: {
        reservation_id: reservation.id,
        court_id: reservation.courtId
      },
      payer: {
        email: getPayerEmail(reservation.user?.email),
        first_name: reservation.user?.fullName ?? reservation.guestName ?? "Cliente"
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Mercado Pago rejeitou o Pix (${response.status}): ${body}`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }

  const data = await response.json() as MercadoPagoPayment;

  return {
    provider: "mercado_pago",
    providerPaymentId: String(data.id),
    pixQrCode: data.point_of_interaction?.transaction_data?.qr_code ?? null,
    pixQrCodeBase64: data.point_of_interaction?.transaction_data?.qr_code_base64 ?? null,
    pixExpiresAt: data.date_of_expiration ? new Date(data.date_of_expiration) : reservation.expiresAt
  };
}

async function createStaticPixPayment(reservation: PaymentInput, fallbackReason?: unknown) {
  const code = createStaticPixCode({
    key: temporaryPixKey,
    receiver: temporaryPixReceiver,
    city: temporaryPixCity,
    amountCents: reservation.amountCents,
    txId: reservation.id.slice(0, 25)
  });
  const qrDataUrl = await QRCode.toDataURL(code, {
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 7
  });

  return {
    provider: fallbackReason ? "pix_static_fallback" : "pix_static",
    providerPaymentId: `static_${crypto.randomUUID()}`,
    pixQrCode: code,
    pixQrCodeBase64: qrDataUrl.replace(/^data:image\/png;base64,/, ""),
    pixExpiresAt: reservation.expiresAt,
    rawPayload: fallbackReason ? { fallbackReason } : undefined
  };
}

function getPayerEmail(email?: string | null) {
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith(".local")) {
    return email;
  }
  return "cliente@arenaepv.com.br";
}

export async function getMercadoPagoPayment(providerPaymentId: string) {
  if (!env.MERCADO_PAGO_ACCESS_TOKEN) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado.");
  }

  const response = await fetch(`https://api.mercadopago.com/v1/payments/${providerPaymentId}`, {
    headers: {
      Authorization: `Bearer ${env.MERCADO_PAGO_ACCESS_TOKEN}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Falha ao consultar pagamento no Mercado Pago: ${body}`);
  }

  return response.json() as Promise<MercadoPagoPayment>;
}

function createStaticPixCode(input: {
  key: string;
  receiver: string;
  city: string;
  amountCents: number;
  txId: string;
}) {
  const merchantAccount = emv("00", "BR.GOV.BCB.PIX") + emv("01", input.key);
  const withoutCrc = [
    emv("00", "01"),
    emv("26", merchantAccount),
    emv("52", "0000"),
    emv("53", "986"),
    emv("54", (input.amountCents / 100).toFixed(2)),
    emv("58", "BR"),
    emv("59", normalizePixText(input.receiver).slice(0, 25)),
    emv("60", normalizePixText(input.city).slice(0, 15)),
    emv("62", emv("05", normalizePixText(input.txId).slice(0, 25))),
    "6304"
  ].join("");

  return `${withoutCrc}${crc16(withoutCrc)}`;
}

function emv(id: string, value: string) {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

function normalizePixText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z0-9 $%*+\-./:]/g, "")
    .toUpperCase();
}

function crc16(value: string) {
  let crc = 0xffff;
  for (let index = 0; index < value.length; index++) {
    crc ^= value.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
