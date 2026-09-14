/**
 * Casca do ERP.
 *
 * Estrutura da referência: faixa superior alta em gradiente com a marca em
 * destaque, sidebar clara e larga com grupos expansíveis (ícone + rótulo +
 * chevron) e item ativo em laranja sólido, sobre fundo neutro.
 *
 * Marca: GRUPO SAMPAIO · Gestão Empresarial. Nenhum asset de terceiros.
 */
import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '@/hooks/useSession';
import { logout, switchCompany } from '@/lib/api/client';
import { NAV_ITEMS, type NavChild, type NavItem } from './navItems';
import { Chevron, NavIcon } from './icons';
import { EstadoConexao } from './EstadoConexao';
import { environmentOf, perfilAtende, type Environment } from '@/router/environments';
import { acessoPersonalizado, telaAbre } from '@/lib/acesso/acesso';

/**
 * Quem vê o menu: o AMBIENTE e o PERFIL de hoje — ou, para o acesso
 * PERSONALIZADO na tela de Usuários, as CAPABILITIES do vínculo (a tela do
 * item abre para este acesso). `capabilities` só vem para o personalizado.
 */
type QuemVe = {
  environment: Environment | null;
  profileCode: string | null | undefined;
  capabilities: readonly string[] | null;
};

/**
 * O grupo aparece neste ambiente, para este perfil?
 *
 * O padrão de AMBIENTE é `gestao` porque este menu É o do escritório. Sem esse
 * padrão, um grupo novo nasceria visível para todo mundo — que é exatamente
 * como o mecânico passou a enxergar Financeiro, Vendas e Estoque.
 *
 * O padrão de PERFIL é o oposto — ausente, todo perfil do ambiente vê — e é
 * assim de propósito: quase toda tela do escritório serve o escritório
 * inteiro, e um padrão restritivo aqui apagaria sessenta itens do menu do
 * gerente sem que ninguém tivesse pedido. Quem precisa do recorte declara.
 *
 * Acesso personalizado: o item folha aparece se a tela dele abre; o grupo sem
 * tela própria aparece se algum filho aparece (a regra de baixo).
 */
function canSee(item: NavItem, quem: QuemVe): boolean {
  if (quem.capabilities) return item.to ? telaAbre(quem.capabilities, item.to) === true : true;
  if (!quem.environment) return false;
  if (!(item.environments ?? ['gestao']).includes(quem.environment)) return false;
  return perfilAtende(quem.profileCode, item.profiles);
}

/**
 * O subitem aparece neste ambiente, para este perfil?
 *
 * Herda do grupo quando não declara nada — um item novo não deve nascer mais
 * visível do que o grupo que o contém. Vale para as duas dimensões.
 */
function canSeeChild(child: NavChild, parent: NavItem, quem: QuemVe): boolean {
  if (quem.capabilities) return child.to ? telaAbre(quem.capabilities, child.to) === true : false;
  if (!quem.environment) return false;
  if (!(child.environments ?? parent.environments ?? ['gestao']).includes(quem.environment)) {
    return false;
  }
  return perfilAtende(quem.profileCode, child.profiles ?? parent.profiles);
}

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const session = useSession();
  const environment = environmentOf(session?.user.profileCode);
  const profileCode = session?.user.profileCode ?? null;
  // Começa TUDO fechado.
  //
  // Antes abria com Estoque, Vendas e Oficina expandidos, e o menu entrava na
  // tela com três grupos abertos ao mesmo tempo — o operador precisava rolar e
  // fechar antes de achar o que queria. Fechado, cada grupo é uma linha só: o
  // menu inteiro cabe de uma vez, e um clique abre o que interessa.
  const [expanded, setExpanded] = useState<string[]>([]);

  const toggle = (label: string) =>
    setExpanded((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );

  /*
    Os filhos são filtrados AQUI, junto do grupo, porque a visibilidade do
    grupo depende deles: um grupo é só um título, e título que expande para o
    nada não é menu — é o defeito que a auditoria integral deixou à mostra no
    Fiscal, cujos cinco filhos declaram `profiles` que excluem o estoquista e
    o atendente, enquanto o grupo (sem perfil próprio) continuava na coluna
    dos dois, vazio.

    A regra é estrutural, não uma lista de perfis copiada para o grupo: os
    filhos já dizem quem vê o quê, e repetir a soma deles no grupo criaria uma
    segunda verdade que envelhece sozinha. Item folha (`to` sem filhos)
    continua valendo por si.
  */
  const quem: QuemVe = {
    environment,
    profileCode,
    capabilities: acessoPersonalizado(session) ? session!.access!.capabilities : null,
  };
  const visible = NAV_ITEMS.filter((item) => canSee(item, quem))
    .map((item) => ({
      item,
      filhos: item.children?.filter((child) => canSeeChild(child, item, quem)) ?? [],
    }))
    .filter(({ item, filhos }) => Boolean(item.to) || filhos.length > 0);

  const rootLink = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-5 py-3 no-underline text-[length:var(--gs-text-base)] font-semibold
     tracking-wide uppercase transition-colors ${
       isActive
         ? 'bg-[var(--gs-sidebar-active)] text-[var(--gs-sidebar-active-text)]'
         : 'text-[var(--gs-text-soft)] hover:bg-[var(--gs-surface-hover)]'
     }`;

  const childLink = ({ isActive }: { isActive: boolean }) =>
    `flex flex-col gap-0.5 pl-[52px] pr-5 py-2 no-underline text-[length:var(--gs-text-base)]
     transition-colors ${
       isActive
         ? 'bg-[var(--gs-sidebar-active)] text-[var(--gs-sidebar-active-text)] font-semibold'
         : 'text-[var(--gs-text-soft)] hover:bg-[var(--gs-surface-hover)]'
     }`;

  return (
    <nav
      aria-label="Menu principal"
      className={`fixed lg:sticky top-[var(--gs-topbar-height)] left-0 z-30
        w-[var(--gs-sidebar-width)] shrink-0 h-[calc(100vh-var(--gs-topbar-height))]
        overflow-y-auto bg-[var(--gs-sidebar)] border-r border-[var(--gs-border)]
        transition-transform lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}`}
    >
      <ul className="list-none p-0 m-0 py-1">
        {visible.map(({ item, filhos }) => {
          const isOpen = expanded.includes(item.label);
          return (
            <li key={item.label}>
              {item.to ? (
                <NavLink to={item.to} className={rootLink} onClick={onNavigate}>
                  <NavIcon name={item.icon} className="shrink-0 text-[var(--gs-purple-700)]" />
                  {item.label}
                </NavLink>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => toggle(item.label)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center gap-3 px-5 py-3 bg-transparent border-0
                      cursor-pointer text-[length:var(--gs-text-base)] font-semibold uppercase
                      tracking-wide text-[var(--gs-text-soft)] hover:bg-[var(--gs-surface-hover)]"
                  >
                    <NavIcon
                      name={item.icon}
                      className="shrink-0 text-[var(--gs-purple-700)]"
                    />
                    <span className="flex-1 text-left">{item.label}</span>
                    <Chevron open={isOpen} className="shrink-0 text-[var(--gs-muted)]" />
                  </button>

                  {isOpen && (
                    <ul className="list-none p-0 m-0 pb-1">
                      {filhos.map((child) => (
                        <li key={child.label}>
                          {child.to ? (
                            <NavLink to={child.to} className={childLink} onClick={onNavigate}>
                              <span>{child.label}</span>
                              {child.hint && (
                                <span className="text-[length:var(--gs-text-xs)] opacity-75">
                                  {child.hint}
                                </span>
                              )}
                            </NavLink>
                          ) : (
                            // Módulo ainda não implementado: aparece para dar
                            // noção do escopo, mas não finge ser navegável.
                            <span
                              className="flex items-center justify-between pl-[52px] pr-5 py-2
                                text-[length:var(--gs-text-base)] text-[var(--gs-muted)] opacity-60"
                              title="Módulo ainda não disponível"
                            >
                              {child.label}
                              <span className="text-[length:var(--gs-text-xs)] uppercase">em breve</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Topbar({ onToggleMenu }: { onToggleMenu: () => void }) {
  const session = useSession();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const handleSwitch = async (companyId: string) => {
    // Trocar para a operação em que já se está não é troca: emitiria token
    // novo e recarregaria a página à toa. Vale também como trava contra
    // `change` disparado sem alguém ter escolhido nada.
    if (!companyId || companyId === session?.company.id) return;
    await switchCompany(companyId);
    // Recarrega para que todas as telas releiam os dados no novo escopo.
    window.location.reload();
  };

  return (
    <header
      className="sticky top-0 z-40 h-[var(--gs-topbar-height)] flex items-center gap-5 px-5 text-white"
      style={{ background: 'var(--gs-header-gradient)' }}
    >
      <button
        type="button"
        onClick={onToggleMenu}
        aria-label="Alternar menu"
        className="lg:hidden bg-transparent border-0 text-white text-2xl cursor-pointer px-1"
      >
        ☰
      </button>

      <div className="flex flex-col leading-tight min-w-0">
        <span className="font-bold tracking-tight text-[26px] whitespace-nowrap">
          GRUPO SAMPAIO
        </span>
        <span className="hidden sm:block text-[length:var(--gs-text-sm)] opacity-80 whitespace-nowrap">
          Gestão Empresarial
        </span>
      </div>

      {session && (
        <span className="hidden md:block pl-5 ml-1 border-l border-white/25 text-[length:var(--gs-text-lg)] font-semibold truncate">
          {session.company.tradeName}
        </span>
      )}

      <div className="ml-auto flex items-center gap-3 min-w-0">
        {session && session.companies.length > 1 && (
          <select
            aria-label="Operação ativa"
            // O navegador restaura valor de formulário ao recarregar. Aqui isso
            // trocaria a operação ativa sem ninguém ter pedido — e venda, caixa
            // e nota fiscal iriam para a empresa errada.
            autoComplete="off"
            value={session.company.id}
            onChange={(e) => void handleSwitch(e.target.value)}
            className="bg-white/15 text-white border border-white/30 rounded-[var(--gs-radius)]
              px-3 py-2 text-[length:var(--gs-text-base)] max-w-[200px]"
          >
            {session.companies.map((c) => (
              <option key={c.id} value={c.id} className="text-[var(--gs-text)]">
                {c.tradeName}
              </option>
            ))}
          </select>
        )}
        {session && (
          <span className="hidden md:flex flex-col items-end leading-tight min-w-0">
            <span className="text-[length:var(--gs-text-base)] font-semibold truncate max-w-[180px]">
              {session.user.displayName}
            </span>
            <span className="text-[length:var(--gs-text-xs)] opacity-80">
              {session.user.profileCode}
            </span>
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleLogout()}
          className="bg-white/15 hover:bg-white/25 border border-white/30 text-white
            rounded-[var(--gs-radius)] px-4 py-2 text-[length:var(--gs-text-base)] cursor-pointer"
        >
          Sair
        </button>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="min-h-screen bg-[var(--gs-canvas)]">
      <Topbar onToggleMenu={() => setMenuOpen((v) => !v)} />
      {/*
        Some sozinho quando há conexão e a fila está vazia. Barra permanente
        vira ruído e deixa de ser vista justamente quando teria algo a dizer.
      */}
      <EstadoConexao />
      <div className="flex items-start">
        <Sidebar open={menuOpen} onNavigate={() => setMenuOpen(false)} />
        {menuOpen && (
          <div
            className="lg:hidden fixed inset-0 top-[var(--gs-topbar-height)] bg-black/30 z-20"
            onClick={() => setMenuOpen(false)}
            aria-hidden
          />
        )}
        <main className="flex-1 min-w-0 p-6 lg:p-7">{children}</main>
      </div>
    </div>
  );
}
