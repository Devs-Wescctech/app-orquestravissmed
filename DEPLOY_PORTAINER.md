# Deploy VisMed no Portainer (container único, sem stack)

Este guia sobe **API (NestJS) + Web (Next.js) em um único container**, com o
**PostgreSQL rodando no host** (fora do container). Só a porta **5000** é exposta —
o frontend já proxia `/api/*` para a API local (`localhost:3000`) via
`apps/web/next.config.js`.

---

## 1. Gerar a imagem Docker

Escolha **uma** das opções.

### Opção 0 — Build 100% pelo Portainer, via Stack a partir do Git (repo privado)
⚠️ O **Images → Build a new image** do Portainer **não faz git clone**: o campo `URL`
só aceita link direto para um **Dockerfile** ou um **tarball**. Apontar para a página do
repositório GitHub falha com `unsupported Content-Type "text/html"`. Para repo
**privado**, o único jeito nativo de buildar dentro do Portainer (sem terminal) é uma
**Stack a partir de Git**, que usa o `docker-compose.portainer.yml` da raiz só para
buildar o Dockerfile e subir o container único.

1. **Stacks → Add stack**.
2. **Name**: `vismed`.
3. **Build method**: `Repository`.
4. **Repository URL**: `https://github.com/Devs-Wescctech/app-orquestravissmed`.
5. **Repository reference**: `refs/heads/main`.
6. **Authentication**: ligue (repo privado) → usuário do GitHub + Personal Access
   Token (PAT) com leitura do repo.
7. **Compose path**: `docker-compose.portainer.yml`.
8. Em **Environment variables**, defina `DATABASE_URL` e `JWT_SECRET` (ver seção 4).
9. **Deploy the stack**. O Portainer clona o repo, builda a imagem e sobe o container.

> Isso builda **e** sobe tudo de uma vez pela UI. Se usar esta opção, você pode pular
> o passo 3 (Add container) — o container já sobe pela stack.

### Opção A — Build local + push para um registry
```bash
# Na raiz do projeto (onde está o Dockerfile)
docker build -t SEU_REGISTRY/vismed:latest .
docker push SEU_REGISTRY/vismed:latest
```
No Portainer, use `SEU_REGISTRY/vismed:latest` como imagem.

### Opção B — Build direto no host do Portainer
Copie o repositório para o host e rode:
```bash
docker build -t vismed:latest .
```
A imagem `vismed:latest` fica disponível localmente para o Portainer.

> **CI/CD / registry privado (opcional, fora do escopo):** você pode automatizar o
> build/push a partir do repositório `Devs-Wescctech/app-orquestravissmed` com um
> pipeline e um registry privado. Não é necessário para este deploy manual.

---

## 2. Preparar o PostgreSQL do host para aceitar o container

O container acessa o Postgres do host via `host.docker.internal`. Libere o acesso:

1. **`postgresql.conf`** — permitir conexões de rede:
   ```
   listen_addresses = '*'
   ```
2. **`pg_hba.conf`** — liberar a subnet da bridge Docker (padrão `172.17.0.0/16`;
   confirme com `docker network inspect bridge`):
   ```
   host    all    all    172.17.0.0/16    scram-sha-256
   ```
3. Reiniciar o serviço:
   ```bash
   sudo systemctl restart postgresql
   ```

> Garanta que o usuário/senha/database do `DATABASE_URL` existam no Postgres do host.

---

## 3. Criar o container no Portainer (Add container)

1. **Containers → Add container**.
2. **Name**: `vismed`.
3. **Image**: `vismed:latest` (ou `SEU_REGISTRY/vismed:latest`).
4. **Port mapping** (Network ports configuration):
   - `host 5000` → `container 5000` (ajuste a porta do host se quiser, ex. `8080:5000`).
5. **Env** (aba *Env*) — ver seção 4.
6. **Runtime & Resources → Add an entry to /etc/hosts** (extra hosts):
   - `host.docker.internal:host-gateway`
   (Isso faz o container enxergar o Postgres do host.)
7. **Restart policy**: `Unless stopped`.
8. **Deploy the container**.

> Alternativa por CLI (equivalente ao passo acima):
> ```bash
> docker run -d --name vismed \
>   -p 5000:5000 \
>   --add-host=host.docker.internal:host-gateway \
>   --restart unless-stopped \
>   --env-file vismed.env \
>   vismed:latest
> ```

---

## 4. Variáveis de ambiente

Obrigatórias:

| Variável | Exemplo / Descrição |
|---|---|
| `DATABASE_URL` | `postgresql://USER:SENHA@host.docker.internal:5432/vismed?schema=public` |
| `JWT_SECRET` | chave forte para assinar os JWTs |

Opcionais / com default:

| Variável | Default | Descrição |
|---|---|---|
| `VISMED_API_PORT` | `3000` | porta interna da API (o proxy do web usa a mesma) |
| `NODE_ENV` | `production` | já definido na imagem |
| `SKIP_DB_INIT` | `false` | `true` pula o `prisma db push` no start |
| `SKIP_SEED` | `false` | `true` pula o seed no start |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | — | opcionais (BullMQ). Sem Redis, o sync roda inline; `ECONNREFUSED 6379` nos logs é esperado e não-fatal. |
| `DISABLE_SYNC_CRON` | — | `true` desliga o scheduler de sync |

> **Credenciais das integrações (VisMed / Doctoralia)** não são env vars: ficam no
> banco (`IntegrationConnection`) e são criadas pelo seed / pela UI. Nada a configurar
> no container além do `DATABASE_URL` apontando para o banco correto.

---

## 5. Inicialização do banco (o que o container faz no start)

No boot, o `docker-entrypoint.sh`:
1. Roda `prisma db push` (idempotente, **sem** `--accept-data-loss`) — cria/atualiza o
   schema sem apagar dados. Pule com `SKIP_DB_INIT=true`.
2. Roda o `seed.js` (idempotente — `upsert`/`findFirst`). Pule com `SKIP_SEED=true`.
3. Sobe API (`node dist/main.js`) e Web (`next start -p 5000`) juntos; se um cair, o
   container encerra e a *restart policy* reinicia.

**Passo manual (alternativa)** — se preferir controlar a migração fora do boot, setar
`SKIP_DB_INIT=true` e `SKIP_SEED=true` e rodar uma vez:
```bash
docker exec -it vismed npx prisma db push --schema=/app/apps/api/prisma/schema.prisma --skip-generate
docker exec -it vismed node /app/apps/api/prisma/seed.js
```

---

## 6. Validação pós-deploy

1. Logs: `docker logs -f vismed` → deve mostrar API na porta 3000 e Web na 5000 (interna).
2. Acesse `http://HOST:5400` e faça login com as credenciais padrão do seed:
   > A porta **interna** do container é sempre 5000; o `docker-compose.portainer.yml` publica
   > no host em **5400** porque a 5000 do host já é usada por outros apps neste servidor
   > (ex.: `app-politicall` → `5000:5000`). Ajuste o lado esquerdo do mapeamento se precisar.
   - **Email:** `admin@vismed.com` · **Senha:** `admin123`
3. Confirme o proxy: o login chama `POST /api/auth/login`, que o Next.js roteia para a
   API local — se o login funciona, o proxy `/api/*` está ok.

---

## Notas

- **Sem stack / docker-compose:** intencional (deploy via *Add container*).
- **Postgres no host:** o banco **não** roda no container.
- **Imagem:** multi-stage (builder + runtime); base `node:20-bookworm-slim` nas duas
  etapas para o Prisma Engine (target `native`) ser compatível em runtime.
