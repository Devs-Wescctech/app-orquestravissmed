---
name: Histórico de schema no Portainer
description: Por que migrations pendentes não autorizam replay no banco legado mantido por db push.
---

O banco legado do Portainer foi mantido por `db push`; migrations listadas como
pendentes não provam que seu DDL esteja ausente. Não recomendar aplicação global,
resolução ou baseline do histórico sem auditoria e autorização separadas.

**Why:** o histórico Prisma e o estado estrutural real podem divergir; tentar
normalizar tudo durante um boot pode repetir DDL antigo, interromper o serviço
ou exigir operações destrutivas não autorizadas.

**How to apply:** tratar mudanças futuras como operações explícitas, com contrato
estrutural read-only, backup restaurável, alvo restrito e falha fechada para schema
parcial. Diferenciar rollback transacional de uma falha da reversão após commit,
que pode destruir dados novos.