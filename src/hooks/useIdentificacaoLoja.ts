/**
 * A identificação legal das lojas — razão social, CNPJ, endereço.
 *
 * Fonte: o endpoint público `/loja/identificacao` (Decreto 7.962/2013 manda
 * expor). Alimenta o rodapé da casca e o "Quem somos" das páginas legais —
 * fonte única: o que o gestor preencher no cadastro fiscal aparece nos dois.
 */
import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api/client';

export interface LojaIdentificada {
  slug: string;
  tradeName: string;
  legalName: string;
  cnpj: string | null;
  address: string | null;
  phone: string | null;
}

/**
 * Cache de módulo: a identificação muda quando o gestor edita o cadastro
 * fiscal — não a cada navegação. Uma busca por sessão de aba basta.
 */
let cache: LojaIdentificada[] | null = null;
/*
  A REVISÃO MORDEU AQUI: página legal monta o "Quem somos" E o rodapé no
  mesmo instante — dois consumidores antes de o cache existir disparavam
  DUAS buscas. A promessa em voo é compartilhada: um voo, todos embarcam.
*/
let emVoo: Promise<LojaIdentificada[]> | null = null;

function buscarIdentificacao(): Promise<LojaIdentificada[]> {
  if (!emVoo) {
    emVoo = apiRequest<{ stores: LojaIdentificada[] }>('/loja/identificacao', {
      anonymous: true,
    })
      .then((r) => {
        // Blindado: dublê de teste ou resposta capenga nunca vira undefined.
        const stores = Array.isArray(r?.stores) ? r.stores : [];
        cache = stores;
        return stores;
      })
      .catch(() => {
        // Sem rede, a página continua legível — e a próxima montagem tenta de novo.
        emVoo = null;
        return [];
      });
  }
  return emVoo;
}

export function useIdentificacaoLoja(): LojaIdentificada[] {
  const [lojas, setLojas] = useState<LojaIdentificada[]>(cache ?? []);
  useEffect(() => {
    if (cache) return;
    let vivo = true;
    void buscarIdentificacao().then((stores) => {
      if (vivo && stores.length) setLojas(stores);
    });
    return () => {
      vivo = false;
    };
  }, []);
  return lojas;
}

/** Para os testes: derruba o cache entre renderizações. */
export function limparCacheIdentificacao(): void {
  cache = null;
  emVoo = null;
}
