'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen } from 'lucide-react';

export function HelpContent({ content }: { content: string }) {
    return (
        <div className="p-6 md:p-8 max-w-4xl mx-auto">
            <div className="flex items-center gap-3 mb-6">
                <div className="h-10 w-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                    <BookOpen className="h-5 w-5 text-emerald-500" />
                </div>
                <div>
                    <h1 className="text-2xl font-semibold text-slate-900">Manual de Utilização</h1>
                    <p className="text-sm text-slate-500">Cadastro e configuração de clínica, passo a passo</p>
                </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 py-8 md:px-10">
                <article
                    className="
                        [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-slate-900 [&_h1]:mb-4
                        [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-slate-900 [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:pb-2 [&_h2]:border-b [&_h2]:border-slate-200
                        [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-slate-800 [&_h3]:mt-6 [&_h3]:mb-2
                        [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-slate-600 [&_p]:mb-3
                        [&_li]:text-sm [&_li]:leading-relaxed [&_li]:text-slate-600 [&_li]:mb-1.5
                        [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4
                        [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-4
                        [&_strong]:text-slate-900 [&_strong]:font-semibold
                        [&_code]:text-[13px] [&_code]:bg-slate-100 [&_code]:text-emerald-700 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded
                        [&_blockquote]:border-l-4 [&_blockquote]:border-emerald-400 [&_blockquote]:bg-emerald-50/60 [&_blockquote]:rounded-r-lg [&_blockquote]:px-4 [&_blockquote]:py-2 [&_blockquote]:my-4 [&_blockquote_p]:mb-0 [&_blockquote_p]:text-slate-700
                        [&_hr]:my-8 [&_hr]:border-slate-200
                        [&_table]:w-full [&_table]:text-sm [&_table]:mb-4
                        [&_th]:text-left [&_th]:font-semibold [&_th]:text-slate-700 [&_th]:border-b [&_th]:border-slate-200 [&_th]:py-2
                        [&_td]:text-slate-600 [&_td]:border-b [&_td]:border-slate-100 [&_td]:py-2
                        [&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:accent-emerald-500
                    "
                >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                </article>
            </div>
        </div>
    );
}
