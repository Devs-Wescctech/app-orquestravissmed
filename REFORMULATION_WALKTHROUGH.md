# Reformulação VisMed: Docker → Supabase (Walkthrough Final)

Esta reformulação removeu a dependência de ambientes complexos em Docker (NestJS + Prisma + Redis + BullMQ) e migrou o backend para o **Supabase (Database + Auth + Edge Functions)**.

## Mudanças Realizadas

### 1. Migração de Banco de Dados
- **Novas Tabelas (23)**: Todas as tabelas do Prisma foram migradas para SQL nativo no Supabase, mantendo integridade, constraints e triggers.
- **RLS (Row Level Security)**: Implementadas políticas de isolamento multi-tenant baseadas em `user_clinic_roles`. O acesso agora é segmentado por `clinic_id` para administradores e operadores.
- **Enums**: Criados tipos nativos para status de mapeamento, papéis de usuário, status de agendamento, etc.

### 2. Autenticação (Supabase Auth)
- O sistema agora utiliza o Supabase Auth para login por email/senha.
- **Migração Transparente**: Usuários do sistema antigo (bcrypt) migram automaticamente para o Supabase Auth no primeiro login.
- Middleware do frontend atualizado para validar sessões via `@supabase/ssr`.

### 3. Backend (7 Edge Functions)
Todo o lógica da API NestJS foi portada para Edge Functions Deno no Supabase:
- `api-auth`: Profile e Login.
- `api-users`: Gerenciamento completo de usuários.
- `api-clinics`: CRUD de clínicas + Testes de integração (Doctoralia/VisMed).
- `api-doctors`: Listagem e sincronização rápida.
- `api-appointments`: Gestão de slots, agendamentos e dashboard stats.
- `api-mappings`: Matching engine entre VisMed e Doctoralia.
- `api-sync`: O substituto do BullMQ — processamento direto de sincronização VisMed e Doctoralia com persistência de log.

### 4. Frontend (Next.js)
- Removido `axios` e `api.ts` original.
- Implementado `callEdgeFunction()` no arquivo `src/lib/supabase.ts` para chamadas seguras às Edge Functions.
- O wrapper em `src/lib/api.ts` garante compatibilidade reversa para todas as páginas existentes (`api.get('/doctors')`, etc.).
- Build realizado com sucesso (`next build`) com 15 rotas estáticas geradas.

---

## Observações Importantes: Doctoralia API (Address Update)

Durante os testes, identificamos um comportamento no Doctoralia PATCH que não está salvando os campos de endereço (`street`, `city_name`, `post_code`) apesar do retorno `200 OK`.

**Causa Provável**: Docplanner ignora o PATCH se a facilidade for uma "referência" ou se campos obrigatórios como `insuranceSupport` não forem enviados com o nome exato esperado pela validação interna.

**Recomendação**:
Se for necessário sincronizar endereços dinamicamente, recomendo:
1. Usar o endpoint direto de Facility addresses (que requer autorização específica no Docplanner).
2. Verificar se o ID do endereço não é uma referência somente leitura à clínica física.

---

## Como Iniciar o Desenvolvimento
Não é mais necessário Docker. Basta rodar localmente:

```bash
cd apps/web
npm run dev
```

O backend já está disponível em: `https://cfwyglawggxmehgjzohz.supabase.co/functions/v1/`
