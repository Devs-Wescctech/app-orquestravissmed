# Manual de Utilização — VisMed

> Guia passo a passo para cadastrar uma clínica e deixá-la sincronizando com a Doctoralia.

Este manual é destinado ao operador do sistema. Nenhum conhecimento técnico é necessário — basta seguir os passos na ordem apresentada.

---

## 1. Acessando o sistema (Login)

1. Abra o endereço do sistema no navegador.
2. Na tela **"Entrar no VisMed"**, informe:
   - **E-mail** — seu e-mail de acesso.
   - **Senha** — sua senha.
3. (Opcional) Marque **"Lembrar-me"** para permanecer conectado.
4. Clique em **Entrar**.

Após o login, você verá o **Dashboard** com o menu lateral à esquerda: **Dashboard**, **Agendamentos**, **Logs de Sincronização**, **Central de Mapeamento**, **Catálogo de Serviços** e, para administradores, **Clínicas**.

> **Atenção:** o cadastro de clínicas fica no menu **Clínicas**, visível apenas para usuários administradores. Se você não vê esse menu, peça a um administrador que faça o cadastro ou ajuste seu perfil.

---

## 2. Cadastrando a clínica

1. No menu lateral, clique em **Clínicas**.
2. Clique no botão **Criar Clínica** (canto superior direito).
3. Na aba **Visão Geral**, preencha:
   - **Friendly Name da Unidade** — nome da clínica como você quer vê-la no sistema.
   - **Cadastro Fiscal (CNPJ)** — CNPJ da clínica.
   - **Temporalidade & Timezone** — fuso horário da clínica (ex.: *Brasil / Sudeste (São Paulo - UTC-3)*).
   - **Endereço** — CEP, Logradouro, Nº, Complemento, Bairro, Cidade e UF.
4. Clique em **Persistir Arquitetura de Dados** para salvar.

A clínica aparece na lista, mas ainda **não sincroniza nada** — é preciso configurar os canais de integração (próximo passo).

---

## 3. Configurando os canais de integração

Abra a clínica cadastrada e vá até a aba **Canais de Integração**. Aqui você conecta o sistema às duas pontas: a **VisMed** (agenda de origem) e a **Doctoralia** (agenda pública).

### 3.1 Credenciais VisMed

No bloco **VisMed Ecosystem**, preencha:

- **Link de Integração (URL)** — o domínio da API VisMed fornecido pela equipe VisMed. Pode ser apenas o domínio (ex.: `app.vissmed.com.br`); o sistema completa o restante automaticamente.
- **ID Empresa Gestora** — o número identificador da empresa gestora na VisMed.

Clique em **Checar Fluxo VisMed** para testar:

- ✅ **Sucesso** — as credenciais estão corretas e o sistema conseguiu falar com a VisMed.
- ❌ **Erro** — confira se o domínio está digitado corretamente e se o ID da Empresa Gestora é o informado pela VisMed. Se persistir, verifique com a equipe VisMed se o acesso está liberado.

### 3.2 Credenciais Doctoralia

No bloco **Doctoralia Ecosystem**, preencha:

- **Domínio** — o domínio da Doctoralia **incluindo o `www`**. Exemplo correto: `www.doctoralia.com.br`. Sem o `www`, a conexão falha.
- **Client ID** e **Client Secret** — credenciais de integração fornecidas pela Doctoralia/Docplanner.
- **Facility ID** — identificador da unidade na Doctoralia (se já souber; caso contrário, será descoberto na primeira sincronização).

Clique em **Testar Conexão Doctoralia**:

- ✅ **Sucesso** — a autenticação funcionou.
- ❌ **Erro** — confira:
  1. O domínio tem `www`? (ex.: `www.doctoralia.com.br`)
  2. Client ID e Client Secret foram copiados sem espaços extras?
  3. As credenciais têm permissão de integração ativa junto à Doctoralia?

Ao final, clique em **Persistir Arquitetura de Dados** para salvar as credenciais.

---

## 4. Primeira sincronização

1. No menu lateral, clique em **Logs de Sincronização**.
2. Clique no botão **Forçar Sync**.
3. O botão muda para **Sincronizando** e o processo começa.

**O que acontece durante o sync:**

- O sistema importa da **VisMed**: unidades, especialidades, profissionais e convênios.
- O sistema importa da **Doctoralia**: unidades (facilities), médicos, serviços e convênios.
- Um "motor de pareamento" tenta casar automaticamente os cadastros dos dois lados.

**O que esperar:**

- A **primeira sincronização é a mais demorada** (pode levar alguns minutos, pois baixa os dicionários completos de serviços e convênios da Doctoralia).
- Acompanhe o andamento nos cards de status da página (**Saúde de Sincronismo**, **Médicos Pareados**, **Convênios Vinculados** etc.) e no histórico recente.
- Depois da primeira vez, o sistema **sincroniza sozinho a cada 30 minutos** — não é preciso clicar em nada. Use **Forçar Sync** apenas quando quiser antecipar uma atualização.

---

## 5. Aprovando os mapeamentos

Após a primeira sincronização, vá em **Central de Mapeamento** no menu lateral. É aqui que você confirma os pareamentos entre VisMed e Doctoralia. Há quatro abas:

### 5.1 Unidades

Confira se cada unidade da VisMed está ligada à unidade correta da Doctoralia.

### 5.2 Profissionais

- Confira se cada médico da VisMed foi pareado com o médico correto da Doctoralia.
- Na coluna **Calendário**, use o botão para deixar o médico **Ativo** (verde). **Somente médicos com calendário Ativo têm seus horários publicados na Doctoralia.**

### 5.3 Especialidades

O sistema pareia especialidades da VisMed com serviços da Doctoralia automaticamente, com três resultados possíveis:

- **Match muito forte** → aprovado automaticamente, nada a fazer.
- **Match provável** → fica como **pendente de revisão**. Use os filtros (**Todos / Pendentes / Aprovados**) para localizar e clique em **Confirmar** (ou **Ignorar** se o pareamento estiver errado).
- **Sem match confiável** → não é criado; a especialidade fica sem vínculo.

> **Importante:** especialidades **pendentes não são enviadas à Doctoralia** até serem confirmadas. Se os horários de um médico não aparecem, verifique se há especialidades pendentes aqui.

### 5.4 Convênios

- Apenas coincidências **exatas de nome** são vinculadas automaticamente.
- Todos os demais ficam **pendentes de revisão**: clique em **Aprovar** para vincular ou **Ignorar** para descartar. Havendo ambiguidade, use **Resolver Conflito**.
- **Ao aprovar um convênio, o sistema envia automaticamente o vínculo para a Doctoralia** — o convênio passa a aparecer na página pública do médico.

---

## 6. Turnos e disponibilidade (horários na Doctoralia)

Os horários exibidos na Doctoralia vêm da **agenda real da VisMed**: se um horário está livre na VisMed, ele aparece; se for bloqueado ou ocupado na VisMed, ele some da Doctoralia (na próxima sincronização).

**Pré-requisitos para os horários de um médico aparecerem na Doctoralia:**

1. ✅ Médico **pareado** na aba Profissionais da Central de Mapeamento.
2. ✅ **Calendário Ativo** para esse médico.
3. ✅ Especialidades do médico **aprovadas** (sem pendências).
4. ✅ Sincronização executada (manual ou automática).

**Comportamento de segurança (fail-safe):** se algum pré-requisito falta ou se a VisMed não retorna a agenda de um médico, o sistema **não publica nada** para ele — em vez de publicar horários errados. Isso evita agendamentos em horários inexistentes. Corrija o pré-requisito e aguarde (ou force) a próxima sincronização.

---

## 7. Verificação final

1. No menu lateral, abra **Agendamentos**.
2. Confira a agenda nas visualizações **Dia / Semana / Mês**, filtrando por profissional se quiser.
3. Verifique os contadores **Total Agendamentos**, **Sincronizados** e **Pendentes**.
4. Abra a página pública do médico na Doctoralia e confirme que os horários e convênios aparecem.

### ✅ Checklist "sistema configurado corretamente"

- [ ] Clínica cadastrada com nome, CNPJ, timezone e endereço.
- [ ] **Checar Fluxo VisMed** retornou sucesso.
- [ ] **Testar Conexão Doctoralia** retornou sucesso (domínio com `www`).
- [ ] Primeira sincronização concluída sem erro (**Logs de Sincronização**).
- [ ] Unidades conferidas na Central de Mapeamento.
- [ ] Médicos pareados e com **Calendário Ativo**.
- [ ] Especialidades sem pendências de revisão.
- [ ] Convênios aprovados (os que a clínica atende).
- [ ] Horários visíveis na página pública da Doctoralia.
- [ ] Agendamentos aparecendo em **Agendamentos** e marcados como sincronizados.

---

## 8. Solução de problemas comuns

### "Testar Conexão" falha (VisMed)

- Confira o **Link de Integração (URL)** — basta o domínio, sem erros de digitação.
- Confira o **ID Empresa Gestora** com a equipe VisMed.
- Verifique com a VisMed se o acesso de integração está liberado para esse ID.

### "Testar Conexão" falha (Doctoralia)

- O **Domínio** precisa incluir `www` (ex.: `www.doctoralia.com.br`).
- Copie **Client ID** e **Client Secret** novamente, sem espaços no início/fim.
- Confirme com a Doctoralia se as credenciais de integração estão ativas.

### Sincronização não acontece ou fica travada

- Vá em **Logs de Sincronização** e verifique o histórico recente e mensagens de erro.
- Se a fila estiver **Pausada**, clique no botão para reativá-la (**Fila Ativa**).
- Clique em **Forçar Sync** e aguarde. Lembre-se: o sync automático roda a cada 30 minutos.

### Horários (slots) não aparecem na Doctoralia

Verifique, nesta ordem, na **Central de Mapeamento**:

1. O médico está **pareado** (aba Profissionais)?
2. O **Calendário** dele está **Ativo** (verde)?
3. As **especialidades** dele estão aprovadas (sem pendências)?
4. A agenda do médico na **VisMed** tem horários livres no período? (Bloqueios na VisMed removem os horários da Doctoralia.)
5. Após corrigir, clique em **Forçar Sync** e aguarde alguns minutos.

### Convênio não aparece na página pública do médico

- Confira na aba **Convênios** da Central de Mapeamento se o convênio está **aprovado** (pendentes não são publicados).
- Após aprovar, o envio à Doctoralia é automático; aguarde alguns minutos e recarregue a página pública.

### Um agendamento feito na Doctoralia não apareceu na VisMed (ou vice-versa)

- A sincronização de agendamentos é bidirecional, mas pode levar alguns minutos.
- Verifique em **Agendamentos** se ele consta como **Pendente**.
- Se após ~30 minutos ainda não espelhou, verifique os **Logs de Sincronização** por erros e acione o suporte.

---

*Dúvidas não cobertas por este manual? Entre em contato com o suporte da plataforma VisMed.*
