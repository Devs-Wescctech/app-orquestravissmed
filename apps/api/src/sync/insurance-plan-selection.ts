export type PlanSelection = {
  id: string | null;
  reason:
    | 'single_plan'
    | 'no_available_plan'
    | 'selection_required'
    | 'invalid_catalog';
};

/** A sole valid plan is unambiguous. Multiple plans require clinic configuration. */
export function selectInsurancePlan(input: unknown): PlanSelection {
  const response = input as {
    _items?: unknown;
    _links?: { next?: unknown };
    pages?: unknown;
    total?: unknown;
  } | null;
  if (
    !Array.isArray(response?._items) ||
    response._links?.next ||
    Number(response.pages || 1) > 1 ||
    Number(response.total || 0) > response._items.length
  )
    return { id: null, reason: 'invalid_catalog' };
  const ids = new Set<string>();
  for (const raw of response._items as unknown[]) {
    const item = raw as { insurance_plan_id?: unknown } | null;
    const id = item?.insurance_plan_id;
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      !/^[1-9]\d*$/.test(String(id))
    )
      return { id: null, reason: 'invalid_catalog' };
    ids.add(String(id));
  }
  return ids.size === 1
    ? { id: [...ids][0], reason: 'single_plan' }
    : {
        id: null,
        reason: ids.size ? 'selection_required' : 'no_available_plan',
      };
}

export const PLAN_REMEDIATION = {
  no_available_plan:
    'Não há plano disponível no catálogo da Doctoralia; conferir o cadastro do convênio com a Doctoralia.',
  selection_required:
    'Há vários planos disponíveis; selecionar os planos aceitos no endereço da Doctoralia.',
  invalid_catalog:
    'O catálogo de planos está inválido ou incompleto; verificar a integração.',
};
