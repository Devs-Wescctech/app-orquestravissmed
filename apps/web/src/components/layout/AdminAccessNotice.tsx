export function AdminAccessNotice() {
    return (
        <div role="status" className="max-w-3xl mx-auto rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <h1 className="text-xl font-bold text-slate-900">Acesso restrito ao Super Admin</h1>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">A gestão de usuários, vínculos e configurações das clínicas é realizada pelo Super Admin. Seu nome e sua senha continuam disponíveis no próprio perfil.</p>
        </div>
    );
}
