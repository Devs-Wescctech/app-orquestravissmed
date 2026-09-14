export function canManageAccounts(user: { active?: boolean; roles?: { role: string }[] } | null | undefined): boolean {
    return user?.active !== false && !!user?.roles?.some(role => role.role === 'SUPER_ADMIN');
}
