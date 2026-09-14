/**
 * A casca da loja: um cabeçalho e um rodapé, para todas as telas do cliente.
 *
 * Até a rodada 37, LojaPage, ProdutoLojaPage e MinhaContaPage redeclaravam cada
 * uma a própria `Moldura` — três cabeçalhos parecidos, e nenhum lugar onde o
 * cliente entrasse na conta. O portal existia inteiro (pedidos, endereços,
 * equipamentos) e não tinha porta: o único jeito de chegar era digitar
 * `/minha-conta` na barra de endereço. Esta casca é a porta.
 *
 * O QUE ELA SEMPRE MOSTRA:
 *   - a marca, que leva de volta à vitrine;
 *   - a entrada da conta: "Entre ou cadastre-se" para quem não está logado,
 *     "Olá, {e-mail}" com atalho para sair para quem está. Ela ouve o login e
 *     troca na hora, sem recarregar (ver `PORTAL_EVENT`).
 *
 * O QUE É OPCIONAL, por prop:
 *   - `direita`: um espaço à direita do cabeçalho — a LojaPage põe o carrinho
 *     ali, porque o carrinho vive no estado dela, não aqui;
 *   - `larguraMax`: a vitrine é larga (6xl), a conta é estreita (4xl).
 *
 * A OFICINA NÃO É LOJA: ela não aparece no rodapé nem na marca. Decisão do
 * dono — a assistência da moto vive no portal (Meus equipamentos), não na
 * vitrine.
 */
import { coreApi } from '@/lib/api/core';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useIdentificacaoLoja } from '@/hooks/useIdentificacaoLoja';
import {
  PORTAL_EVENT,
  lerSessaoPortal,
  guardarSessaoPortal,
  type SessaoPortal,
} from '@/lib/portalSession';
import { apiRequest } from '@/lib/api/client';
import { esquecerCarrinhoDaConta } from '@/lib/carrinhoLocal';
import { useRenovacaoDaSessao } from '@/hooks/useRenovacaoDaSessao';

/** A marca que a página veste. Sem ela, a casca é a do Grupo. */
export interface MarcaDaLoja {
  slug: string;
  nome: string;
  logoUrl?: string | null;
}

interface CascaProps {
  children: ReactNode;
  /** Classe de largura do conteúdo. Vitrine larga, conta estreita. */
  larguraMax?: 'max-w-6xl' | 'max-w-4xl';
  /** Conteúdo à direita do cabeçalho — tipicamente o botão do carrinho. */
  direita?: ReactNode;
  /**
   * A página da marca (rodada 40): muda a paleta inteira via
   * `data-marca="<slug>"` — os tokens fazem o resto, nenhuma tela reescrita —
   * e o cabeçalho mostra o logo (ou o nome tipográfico) da loja, com o
   * caminho de volta ao Grupo.
   */
  marca?: MarcaDaLoja | null;
}

/** Lê a sessão do portal e reage ao login/logout na mesma aba e entre abas. */
function useSessaoPortal(): SessaoPortal | null {
  const [sessao, setSessao] = useState<SessaoPortal | null>(() => lerSessaoPortal());
  useEffect(() => {
    const atualizar = () => setSessao(lerSessaoPortal());
    // `PORTAL_EVENT`: login/logout nesta aba. `storage`: em outra aba. `focus`:
    // a sessão pode ter vencido enquanto a aba estava em segundo plano.
    window.addEventListener(PORTAL_EVENT, atualizar);
    window.addEventListener('storage', atualizar);
    window.addEventListener('focus', atualizar);
    return () => {
      window.removeEventListener(PORTAL_EVENT, atualizar);
      window.removeEventListener('storage', atualizar);
      window.removeEventListener('focus', atualizar);
    };
  }, []);
  return sessao;
}

function EntradaDaConta() {
  const sessao = useSessaoPortal();
  // Enquanto a pessoa usa a loja, a sessão acompanha (GAP-PRD-193).
  useRenovacaoDaSessao(sessao);

  if (!sessao) {
    return (
      <Link
        to="/minha-conta"
        className="text-white no-underline text-[length:var(--gs-text-sm)] font-semibold
          bg-white/15 hover:bg-white/25 border border-white/30 rounded-[var(--gs-radius)]
          px-3 sm:px-4 py-2 whitespace-nowrap"
      >
        Entre ou cadastre-se
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link
        to="/minha-conta"
        className="text-white no-underline text-[length:var(--gs-text-sm)] font-semibold
          hover:underline max-w-[40vw] truncate"
        title={sessao.account.email}
      >
        Olá, {sessao.account.email}
      </Link>
      <button
        type="button"
        onClick={() => {
          /*
            SAIR DE VERDADE (GAP-PRD-193): a sessão morre no servidor — antes
            só sumia deste navegador e continuava valendo por quem tivesse o
            token — e a cópia do carrinho da conta sai do aparelho (ela fica
            guardada na conta).
          */
          void apiRequest('/loja/portal/sair', {
            method: 'POST',
            anonymous: true,
            headers: { 'x-portal-token': sessao.token },
          }).catch(() => undefined);
          esquecerCarrinhoDaConta();
          guardarSessaoPortal(null);
        }}
        className="text-white/80 hover:text-white text-[length:var(--gs-text-sm)] bg-transparent
          border-0 cursor-pointer underline px-2 py-1"
      >
        Sair
      </button>
    </div>
  );
}

export function CascaDaLoja({ children, larguraMax = 'max-w-6xl', direita, marca }: CascaProps) {
  return (
    <div
      className="min-h-screen bg-[var(--gs-canvas)] flex flex-col"
      data-marca={marca?.slug}
    >
      <header
        /*
          Compacto no celular: medido em 375px, o cabeçalho ocupava 171px —
          21% da tela antes do primeiro produto. O padding e o vão vertical
          encolhem em base e voltam no sm.
        */
        className="text-white px-4 sm:px-6 py-3 sm:py-4"
        style={{ background: 'var(--gs-header-gradient)' }}
      >
        <div className={`${larguraMax} mx-auto flex items-center gap-x-4 gap-y-2 flex-wrap`}>
          {marca ? (
            <div className="flex items-center gap-3">
              <Link
                to={`/${marca.slug}`}
                className="text-white no-underline leading-tight flex items-center gap-3"
              >
                {marca.logoUrl ? (
                  <img
                    /*
                      alt vazio de propósito: o NOME está no <span> ao lado,
                      dentro do mesmo link — alt={nome} fazia o leitor de tela
                      anunciar a loja duas vezes seguidas.
                    */
                    src={coreApi.imageUrl(marca.logoUrl)}
                    alt=""
                    aria-hidden
                    className="h-10 w-10 rounded-full object-cover bg-white/10"
                  />
                ) : null}
                {/* 26px cru estava fora da escala de 7 degraus — e quase
                    empatado com o h1 de 28 da página. Entra na escala: 22 no
                    celular, 28 do sm em diante. */}
                <span className="text-[length:var(--gs-text-xl)] sm:text-[length:var(--gs-text-2xl)] font-bold">
                  {marca.nome}
                </span>
              </Link>
              <Link
                to="/loja"
                className="text-white/70 hover:text-white no-underline text-[length:var(--gs-text-xs)]
                  uppercase tracking-[0.15em] border-l border-white/30 pl-3"
              >
                Grupo Sampaio
              </Link>
            </div>
          ) : (
            <Link to="/loja" className="text-white no-underline leading-tight">
              <p className="uppercase tracking-[0.2em] text-[length:var(--gs-text-xs)] opacity-80 m-0">
                Grupo
              </p>
              <span className="text-[length:var(--gs-text-xl)] sm:text-[length:var(--gs-text-2xl)] font-bold">
                GRUPO SAMPAIO
              </span>
            </Link>
          )}
          <div className="ml-auto flex items-center gap-3 flex-wrap">
            <EntradaDaConta />
            {direita}
          </div>
        </div>
      </header>

      <main className={`${larguraMax} w-full mx-auto px-6 py-7 flex-1`}>{children}</main>

      <footer className="border-t border-[var(--gs-border)] mt-8">
        <div
          className={`${larguraMax} mx-auto px-6 py-6 text-[length:var(--gs-text-sm)]
            text-[var(--gs-muted)] flex flex-col gap-1`}
        >
          <p className="m-0 font-semibold text-[var(--gs-text-soft)]">Grupo Sampaio</p>
          <p className="m-0">
            Preço Justo · Gringa · Me Mimei · Conceito · PJ Motors — Pelotas/RS
          </p>
          <p className="m-0">
            <Link to="/minha-conta" className="text-[var(--gs-muted)] hover:underline">
              Minha conta e meus pedidos
            </Link>
            {' · '}
            <Link to="/politica-de-privacidade" className="text-[var(--gs-muted)] hover:underline">
              Privacidade
            </Link>
            {' · '}
            <Link to="/termos-de-uso" className="text-[var(--gs-muted)] hover:underline">
              Termos de Uso
            </Link>
            {' · '}
            <Link to="/trocas-e-devolucoes" className="text-[var(--gs-muted)] hover:underline">
              Trocas e Devoluções
            </Link>
          </p>
          <IdentificacaoLegal marcaSlug={marca?.slug ?? null} />
        </div>
      </footer>
    </div>
  );
}

/**
 * A identificação do FORNECEDOR no rodapé — razão social, CNPJ e endereço
 * (Decreto 7.962/2013). Na página de uma marca, mostra a empresa DAQUELA
 * loja; na home e nas páginas comuns, o bloco compacto de todas.
 *
 * Nomes de marca aqui são TEXTO, nunca link — os testes da página da marca
 * esperam um único link por nome de loja, e o rodapé não disputa com eles.
 */
function IdentificacaoLegal({ marcaSlug }: { marcaSlug: string | null }) {
  const lojas = useIdentificacaoLoja();
  if (lojas.length === 0) return null;
  const daMarca = marcaSlug ? lojas.find((l) => l.slug === marcaSlug) : null;
  const mostradas = daMarca ? [daMarca] : lojas;
  return (
    <div className="mt-2 flex flex-col gap-0.5 text-[length:var(--gs-text-xs)]">
      {mostradas.map((l) => (
        <p key={l.slug} className="m-0">
          {l.legalName}
          {l.cnpj ? ` — CNPJ ${l.cnpj}` : ''}
          {l.address ? ` — ${l.address}` : ''}
          {l.phone ? ` — ${l.phone}` : ''}
        </p>
      ))}
    </div>
  );
}
