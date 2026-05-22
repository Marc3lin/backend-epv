import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3000),
  FRONTEND_URL: z.string().default("http://localhost:5173"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  MERCADO_PAGO_ACCESS_TOKEN: z.string().optional().default(""),
  MERCADO_PAGO_WEBHOOK_SECRET: z.string().optional().default(""),
  MERCADO_PAGO_PIX_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0.99),
  PAYMENTS_MODE: z.enum(["mock", "mercado_pago"]).default("mock")
}).superRefine((value, context) => {
  if (value.JWT_SECRET === "troque-essa-chave-em-producao") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["JWT_SECRET"],
      message: "JWT_SECRET precisa ser trocado por uma chave forte antes de produção."
    });
  }

  if (value.PAYMENTS_MODE === "mercado_pago") {
    if (!value.MERCADO_PAGO_ACCESS_TOKEN) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MERCADO_PAGO_ACCESS_TOKEN"],
        message: "MERCADO_PAGO_ACCESS_TOKEN é obrigatório quando PAYMENTS_MODE=mercado_pago."
      });
    }

    if (value.PUBLIC_BASE_URL.includes("localhost") || value.PUBLIC_BASE_URL.includes("127.0.0.1")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_BASE_URL"],
        message: "PUBLIC_BASE_URL precisa ser pública para o webhook do Mercado Pago."
      });
    }
  }
});

export const env = schema.parse(process.env);
