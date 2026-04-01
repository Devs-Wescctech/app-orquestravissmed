# VisMed Project Rules - Unificado

Este é o arquivo central de regras para o projeto VisMed. Ele deve ser a única fonte de verdade para o comportamento do sistema, arquitetura e padrões de código.

## 1. Arquitetura e Ambiente (Modernização finalizada)
- **ZERO Docker**: O projeto **NÃO** utiliza mais Docker localmente. NestJS, Prisma (local), Redis e BullMQ foram removidos.
- **Desenvolvimento Local**: Execute diretamente no host usando `npm run dev` dentro da pasta `apps/web`.
- **Frontend**: Next.js 14+ (App Router) localizado em `apps/web`.
- **Backend (Serverless)**: 100% das operações de backend ocorrem via **Supabase Edge Functions** (Deno).
- **Banco de Dados**: PostgreSQL gerenciado pelo Supabase.

## 2. Comunicação de Dados & API (CRÍTICO)
- **Não use Axios diretamente para portas locais**: O sistema legado usava a porta `3333`. Essas rotas não existem mais no host.
- **Compatibilidade Retroativa**: Utilize o wrapper `src/lib/api.ts` no frontend. Ele intercepta chamadas estilo Axios (`api.get()`, `api.post()`, etc.) e as redireciona automaticamente para as Edge Functions corretas no Supabase (ex: `api-mappings-v2` v14+ para mapeamentos e `api-sync-v10` para sincronismo).
- **Criação de Novas Features**: Utilize `callEdgeFunction()` importado de `src/lib/supabase.ts` para chamadas diretas às funções serverless.
- **Segurança Edge Functions**: Mantenha sempre `verify_jwt: false` nas funções que utilizam o cookie `vismed_auth_token` para garantir compatibilidade com tokens legados e evitar redirecionamentos indevidos.

## 3. Autenticação (Supabase Auth)
- **Login**: Utiliza-se exclusivamente o Supabase Auth.
- **Sessões**: Gerenciadas via `@supabase/ssr` no middleware do Next.js para proteção de rotas.
- **Legado**: Não use validação manual de JWT baseada em segredos bcrypt locais; o Supabase gerencia a segurança dos tokens.

## 4. Estilização & UI (Padrão Premium)
- **Tailwind CSS**: Framework obrigatório para estilização.
- **Design System**: Siga a identidade visual VisMed:
    - Cores primárias da marca.
    - Fundos off-white/sleek dark.
    - Designs sem bordas brutas (bordas arredondadas e sutis).
    - Micro-animações suaves para feedback de interação.
    - Foco em hierarquia visual limpa e legibilidade.

## 5. Banco de Dados e Segurança (RLS)
- **Multi-tenancy**: O PostgreSQL utiliza **Row Level Security (RLS)**.
- **Políticas de Acesso**: NUNCA exponha dados sem filtro; as políticas estão atreladas à tabela `user_clinic_roles`. O acesso deve ser sempre segmentado por `clinic_id`.
- **Worker & Sincronização**: O BullMQ foi substituído pela Edge Function `api-sync`. Sincronizações com Doctoralia/VisMed são processadas por webhooks ou chamadas diretas à `api-sync`, registrando logs na tabela `sync_logs`.

## 6. Governança e Deploy
- **Segurança**: Não edite chaves de integração da Doctoralia ou variáveis sensíveis sem permissão expressa.
- **Infraestrutura**: Não tente reconstruir arquivos YAML de deploy antigo ou Dockerfiles sem necessidade comprovada de reversão de arquitetura serverless.
- **Mudanças Sensíveis**: Alterações em permissões de RLS ou triggers de banco devem ser documentadas antes da aplicação.

## 7. Mapeamento e Catálogo Global (VisMed-Doctoralia)
- **Integridade de Dados**: Nomes de serviços e especialidades são normalizados (remoção de acentos/lowercase) e protegidos por `UNIQUE` constraints no PostgreSQL para evitar duplicidade.
- **Mapeamento Unificado de Profissionais**: A tabela `professional_unified_mappings` é a fonte de verdade para vínculos entre médicos VisMed e Doctoralia. 
- **Filtragem por Contexto (UI de Mapeamento)**: Para evitar excesso de dados globais, as abas de Especialidades e Unidades devem sempre ser filtradas com base nos profissionais ativos da clínica atual (`Médico -> Especialidade` e `Médico -> Unidade`). Isso garante que o usuário veja apenas o catálogo real da sua operação.
- **Estrutura de Médicos (Doctoralia)**: Como a tabela `doctoralia_doctors` não possui campo de sobrenome, deve-se sempre concatenar "Nome + Sobrenome" no campo `name` durante o sincronismo.
- **Catálogo Global**: A ingestão dos ~10.000 serviços da Doctoralia é processada via `api-sync` (v10) usando paginação por `offset` para contornar limites de memória/timeout (Worker Limits).
- **Motor de Mapeamento**: O cruzamento entre especialidades VisMed e serviços Doctoralia utiliza o RPC `run_specialty_matcher` (SQL com extensão `pg_trgm`).
- **Regra de Aprovação Automática**: 
    - Confiança **>= 70%** (0.7): Mapeamento automático e aprovado.
    - Confiança **< 70%**: Mapeamento sugerido com `requires_review = true` para validação manual.
- **Interface de Consulta**: O menu **Catálogo de Serviços** (`/services`) deve ser a fonte de consulta para IDs de serviços globais, permitindo buscas em tempo real em mais de 10 mil registros.

---
*Este arquivo unifica as diretrizes de `.cursorrules`, `.windsurfrules` e `REFORMULATION_WALKTHROUGH.md`.*
