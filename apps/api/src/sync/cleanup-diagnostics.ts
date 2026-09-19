export const cleanupReasons = {
  journal_missing_periods: 'Histórico antigo sem serviços e durações completos. Não é seguro reconstruir os horários.',
  journal_invalid: 'Registro de horários inválido ou incompleto.',
  journal_scope_mismatch: 'Registro pertence a outro vínculo, unidade ou endereço.',
  journal_hash_mismatch: 'Registro de horários não corresponde à versão salva.',
  invalid_clock: 'Não foi possível validar a data atual.',
  period_in_progress: 'Existe intervalo já iniciado e ainda não encerrado; ele foi preservado.',
  plan_invalid: 'O registro não permite montar uma remoção segura para esta data.',
  mapping_missing: 'Vínculo aprovado da clínica não foi encontrado.',
  mapping_shared: 'O profissional Doctoralia possui outro vínculo aprovado; remoção automática impedida.',
  journal_changed: 'O histórico foi alterado por outra execução. A próxima execução fará nova conferência.',
  eligibility_changed: 'A condição do profissional mudou ou não pôde ser confirmada novamente.',
  authorization_failed: 'Não foi possível confirmar a autorização atual para a limpeza.',
  bookings_present: 'Há reservas nesta data. A limpeza automática preservou a agenda.',
  bookings_incomplete: 'A consulta de reservas veio incompleta ou em formato não confirmado.',
  breaks_present: 'Há bloqueios nesta data. A limpeza automática preservou a agenda.',
  breaks_incomplete: 'A consulta de bloqueios veio incompleta ou em formato não confirmado.',
  remote_mismatch: 'Os horários ou serviços lidos na Doctoralia não correspondem ao histórico completo.',
  remote_changed: 'Os horários mudaram entre as duas conferências anteriores ao envio.',
  remote_read_failed: 'Falha ao consultar a agenda remota antes do envio.',
  write_unconfirmed: 'O envio retornou falha ou timeout; não é possível afirmar se a Doctoralia aplicou a alteração.',
  verification_failed: 'Falha na leitura posterior ao envio; o resultado da alteração ainda é incerto.',
  verification_mismatch: 'A leitura posterior não confirmou o resultado esperado.',
  journal_update_failed: 'A alteração foi confirmada na Doctoralia, mas o histórico local não pôde ser atualizado.',
} as const;
export type CleanupReason = keyof typeof cleanupReasons;
export type CleanupDiagnostic = { code: CleanupReason; writeState: 'not_sent' | 'unknown' | 'confirmed' };
export type CleanupIssue = CleanupDiagnostic & { addressId: string; date?: string };
export function describeCleanupIssues(issues: CleanupIssue[]): string {
  return issues.map(issue => `Endereço ${issue.addressId}${issue.date ? `, data ${issue.date}` : ''}: [${issue.code}] ${cleanupReasons[issue.code]} ${
    issue.writeState === 'not_sent' ? 'Nenhuma remoção enviada.' : issue.writeState === 'unknown' ? 'Resultado remoto ainda não confirmado.' : 'Resultado remoto confirmado; registro local pendente.'
  }`).join(' ');
}
