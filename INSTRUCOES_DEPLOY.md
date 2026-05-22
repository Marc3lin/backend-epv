# Arena EPV - Deploy frontend + backend

## 1. Frontend no Netlify

Use o arquivo:

`arena-epv-netlify.zip`

No Netlify:

1. Acesse **Sites**.
2. Clique em **Add new site**.
3. Escolha **Deploy manually**.
4. Envie o ZIP `arena-epv-netlify.zip`.

Depois que o backend estiver online, configure no Netlify:

`VITE_API_URL=https://URL-DO-SEU-BACKEND`

Depois disso, gere outro build do frontend e suba novamente.

## 2. Backend em serviço Node

Use o arquivo:

`arena-epv-backend-render.zip`

Esse pacote contém:

- backend Node/Fastify
- Prisma
- schema do banco
- arquivos de mídia servidos em `/media`
- `render.yaml`
- `package.json` e `package-lock.json`

## 3. Variáveis obrigatórias do backend

Configure no serviço onde o backend rodar:

```env
DATABASE_URL=postgresql://...
JWT_SECRET=uma-chave-grande-com-mais-de-32-caracteres
FRONTEND_URL=https://URL-DO-NETLIFY
PUBLIC_BASE_URL=https://URL-DO-BACKEND
PAYMENTS_MODE=mercado_pago
MERCADO_PAGO_ACCESS_TOKEN=seu-token-de-producao
MERCADO_PAGO_PIX_FEE_PERCENT=0.99
```

Opcional:

```env
MERCADO_PAGO_WEBHOOK_SECRET=
```

## 4. Comandos do backend

Build:

```bash
npm install
npm --workspace backend run build
npx prisma generate --schema backend/prisma/schema.prisma
```

Start:

```bash
npm --workspace backend run start
```

Primeira configuração do banco:

```bash
npm --workspace backend run db:push
npm --workspace backend run seed
```

Use `seed` apenas se quiser criar os usuários/admins iniciais e dados base.

## 5. Ordem correta

1. Subir banco PostgreSQL.
2. Subir backend.
3. Rodar `db:push`.
4. Rodar `seed`, se necessário.
5. Copiar URL pública do backend.
6. Colocar essa URL em `VITE_API_URL` no frontend.
7. Rebuildar o frontend.
8. Subir o novo ZIP no Netlify.

## 6. Observação importante

O Netlify sozinho não roda esse backend Fastify/Prisma. Ele hospeda o frontend.
O backend precisa ficar em um serviço Node separado, com PostgreSQL.
