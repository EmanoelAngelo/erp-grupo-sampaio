/**
 * Equipe: mecânicos, técnicos e demais usuários da operação.
 *
 * Não há cadastro de "mecânico" separado do de usuário — é a mesma pessoa, com
 * um perfil e um vínculo de oficina. Duas listas de gente seriam duas verdades
 * sobre quem pode entrar, e divergiriam no primeiro desligamento feito só de
 * um lado.
 *
 * O FILTRO DE OFICINA É O ASSUNTO PRINCIPAL da tela, não um enfeite: o técnico
 * de celulares e o de mobilidade estão em operações diferentes e não devem
 * aparecer misturados. O servidor recusa oficina de outro tenant; aqui o
 * filtro existe para o gestor enxergar uma equipe de cada vez.
 *
 * NADA de senha aparece: nem hash, nem a senha em uso. A senha provisória é
 * digitada pelo gestor, vai para o servidor e não volta.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { QuemLiberaAqui } from '@/components/gs/QuemLiberaAqui';
import { RecuperacaoDeSenhaDaOperacao } from '@/components/gs/RecuperacaoDeSenhaDaOperacao';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SearchInput,
} from '@/components/gs/ui';
import { AcessoDoUsuario } from '@/components/gs/AcessoDoUsuario';
import { ApiRequestError, getSession } from '@/lib/api/client';
import { coreApi } from '@/lib/api/core';
import { equipeApi, type MembroDaEquipe } from '@/lib/api/equipe';
import { dataHoraBR } from '@/lib/datas';

/*
  O QUE A TELA OFERECE SOBRE CADA PESSOA VEM DO SERVIDOR (GAP-PRD-010/152).

  A tela oferecia Editar, Resetar senha e Desativar para qualquer pessoa da
  lista — inclusive o administrador do sistema e o gestor do grupo, que o
  gerente de loja não pode tocar. O servidor agora recusa; e a tela deixa de
  oferecer, lendo `acoes`, que é calculado pelas MESMAS funções que recusam.
  Sem `acoes` (servidor antigo), oferece o que sempre ofereceu.
*/
const podeNaOperacao = (m: MembroDaEquipe) => m.acoes?.gerirNaOperacao !== false;
const podeNaConta = (m: MembroDaEquipe) => m.acoes?.gerirConta !== false;

/** "a esta operação" ou "a esta e a mais N operações do grupo". */
function alcanceDoCorte(m: MembroDaEquipe): string {
  const outras = m.acoes?.outrasOperacoes ?? 0;
  if (outras === 0) return 'a esta operação';
  return `a esta e a mais ${outras} ${outras === 1 ? 'operação' : 'operações'} do grupo`;
}

const PERFIL_ROTULO: Record<string, string> = {
  // Estes dois não são atribuíveis pela tela, mas EXISTEM na base e precisam
  // de nome: mostrar "admin_geral" cru é vazar o interno do sistema para quem
  // só quer saber quem é o quê.
  admin_geral: 'Administrador do sistema',
  operador_caixa_loja: 'Operador de caixa (loja)',
  gestor: 'Gestor',
  gerente_loja: 'Gerente de loja',
  gerente_oficina: 'Gerente de oficina',
  mecanico: 'Mecânico / técnico',
  atendente: 'Atendente',
  estoquista: 'Estoquista',
  operador_caixa: 'Operador de caixa',
  operador_caixa_oficina: 'Caixa da oficina',
  /*
    O CONTADOR É O ÚNICO PERFIL DE FORA DA EMPRESA, e o rótulo diz isso.

    A lista de perfis do seletor vem do servidor (`listAssignableProfiles`),
    então ele apareceu aqui sozinho no dia em que entrou em
    `ASSIGNABLE_PROFILES` — mas sem esta linha apareceria como `contador` cru,
    que é o nome interno vazando para a tela.

    "Escritório de contabilidade" e não "Contador" porque quem recebe o login
    normalmente é um escritório, e porque a diferença importa na hora de
    desligar: quando a loja troca de contabilidade, é este acesso que tem de
    ser desativado — e um rótulo que lembra disso vale mais que um nome curto.
  */
  contador: 'Escritório de contabilidade (externo)',
};

/** Perfis que atendem oficina — para eles o vínculo é obrigatório. */
const PERFIS_DE_OFICINA = new Set(['mecanico', 'gerente_oficina', 'operador_caixa_oficina']);

const dataHora = dataHoraBR;

interface Oficina {
  id: string;
  name: string;
}

export default function EquipePage() {
  // Mesma tela, dois recortes. Entrando pela Oficina, a lista já vem só com
  // quem atende bancada — o gerente de oficina não precisa passar os olhos
  // pelo caixa e pelo estoquista para achar seus mecânicos.
  const soOficina = useLocation().pathname.startsWith('/sistema/oficina/');

  const [itens, setItens] = useState<MembroDaEquipe[] | null>(null);
  const [oficinas, setOficinas] = useState<Oficina[]>([]);
  const [perfis, setPerfis] = useState<string[]>([]);
  const [filtroOficina, setFiltroOficina] = useState('');
  const [busca, setBusca] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [editando, setEditando] = useState<MembroDaEquipe | null>(null);
  const [criando, setCriando] = useState(false);
  // O editor de acesso (empresas, PDVs e páginas) — ninguém edita o próprio.
  const [acessoDe, setAcessoDe] = useState<MembroDaEquipe | null>(null);
  const euMesmo = getSession()?.user.id;

  const carregar = useCallback(async () => {
    setError(null);
    try {
      setItens(
        await coreApi.listTeam({
          workshopId: filtroOficina || undefined,
          search: busca.trim() || undefined,
          workshopStaff: soOficina,
        }),
      );
    } catch (err) {
      // Nulo, não vazio: "sem permissão" e "ninguém cadastrado" não podem
      // exibir a mesma coisa.
      setItens(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a equipe.');
    }
  }, [filtroOficina, busca, soOficina]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => {
    void coreApi
      .listWorkshops()
      .then(setOficinas)
      .catch(() => setOficinas([]));
    void coreApi
      .listAssignableProfiles()
      .then(setPerfis)
      .catch(() => setPerfis([]));
  }, []);

  const acao = useCallback(
    async (fn: () => Promise<unknown>, mensagem: string) => {
      setError(null);
      setAviso(null);
      try {
        await fn();
        setAviso(mensagem);
        await carregar();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Não foi possível concluir.');
      }
    },
    [carregar],
  );

  const resumo = useMemo(() => {
    const lista = itens ?? [];
    return {
      ativos: lista.filter((m) => m.active).length,
      inativos: lista.filter((m) => !m.active).length,
    };
  }, [itens]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={soOficina ? ['Oficina', 'Mecânicos e técnicos'] : ['Pessoas', 'Usuários']}
        title={soOficina ? 'Mecânicos e técnicos' : 'Usuários e equipe'}
        actions={
          <Button
            onClick={() => {
              setEditando(null);
              setCriando(true);
            }}
          >
            Cadastrar pessoa
          </Button>
        }
      />

      {/*
        QUEM LIBERA AQUI (GAP-PRD-054): a alçada pontual pressupõe alguém com
        alçada no balcão, e é nesta tela que o dono decide quem. Fora do recorte
        da Oficina, que lista só a bancada.
      */}
      {!soOficina && <QuemLiberaAqui />}
      {/* A escolha do dono sobre "esqueci minha senha" (GAP-PRD-160). */}
      {!soOficina && <RecuperacaoDeSenhaDaOperacao />}

      {(criando || editando) && (
        <div className="mb-5">
          <EquipeForm
            membro={editando}
            oficinas={oficinas}
            perfis={perfis}
            onCancelar={() => {
              setCriando(false);
              setEditando(null);
            }}
            onSalvo={async () => {
              setCriando(false);
              setEditando(null);
              setAviso('Cadastro salvo.');
              await carregar();
            }}
          />
        </div>
      )}

      {acessoDe && (
        <div className="mb-5">
          <AcessoDoUsuario
            key={acessoDe.id}
            userId={acessoDe.id}
            nome={acessoDe.displayName}
            onFechar={() => setAcessoDe(null)}
            onSalvo={async () => {
              setAcessoDe(null);
              setAviso('Acesso salvo.');
              await carregar();
            }}
          />
        </div>
      )}

      <Card
        title="Pessoas"
        subtitle={`${resumo.ativos} com acesso · ${resumo.inativos} desativada(s)`}
      >
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="flex-1">
            <SearchInput value={busca} onChange={setBusca} placeholder="Nome ou login…" />
          </div>
          <select
            value={filtroOficina}
            onChange={(e) => setFiltroOficina(e.target.value)}
            aria-label="Filtrar por oficina"
            className="h-[52px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
              bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
          >
            <option value="">Todas as oficinas</option>
            {oficinas.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p
            role="alert"
            className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
          >
            {error}
          </p>
        )}
        {aviso && (
          <p
            role="status"
            className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-success)]"
          >
            {aviso}
          </p>
        )}

        {itens && (
          <DataTable
            rows={itens}
            keyOf={(m) => m.id}
            empty={
              <EmptyState
                title={busca || filtroOficina ? 'Ninguém encontrado' : 'Equipe vazia'}
                description={
                  busca || filtroOficina
                    ? 'Ajuste a busca ou o filtro de oficina.'
                    : 'Cadastre a primeira pessoa da operação.'
                }
              />
            }
            columns={[
              {
                header: 'Pessoa',
                render: (m) => (
                  <div className="flex flex-col">
                    <span className="font-semibold text-[var(--gs-purple-900)]">
                      {m.displayName}
                    </span>
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {m.login}
                    </span>
                    {(m.acoes?.outrasOperacoes ?? 0) > 0 && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                        também entra em {m.acoes!.outrasOperacoes}{' '}
                        {m.acoes!.outrasOperacoes === 1 ? 'outra operação' : 'outras operações'} do grupo
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Perfil',
                render: (m) => (
                  <span className="text-[length:var(--gs-text-sm)]">
                    {PERFIL_ROTULO[m.profileCode] ?? m.profileCode}
                  </span>
                ),
              },
              {
                header: 'Oficina',
                render: (m) =>
                  m.workshops.length === 0 ? (
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {m.workshops.map((w) => (
                        <Badge key={w.id} tone="info">
                          {w.name}
                        </Badge>
                      ))}
                    </div>
                  ),
              },
              {
                header: 'Acesso',
                render: (m) => (
                  <div className="flex flex-col gap-1 items-start">
                    <Badge tone={m.active ? 'success' : 'danger'}>
                      {m.active ? 'ATIVO' : 'DESATIVADO'}
                    </Badge>
                    {m.mustChangePassword && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
                        troca no 1º acesso
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Último acesso',
                render: (m) => (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                    {dataHora(m.lastLoginAt)}
                  </span>
                ),
              },
              {
                header: 'Ações',
                align: 'right',
                render: (m) => (
                  <div className="flex gap-2 justify-end flex-wrap items-center">
                    {podeNaOperacao(m) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setCriando(false);
                          setEditando(m);
                        }}
                      >
                        Editar
                      </Button>
                    )}
                    {podeNaOperacao(m) && m.id !== euMesmo && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setCriando(false);
                          setEditando(null);
                          setAcessoDe(m);
                        }}
                      >
                        Acesso
                      </Button>
                    )}
                    {podeNaConta(m) && <ResetSenhaBotao membro={m} onFeito={acao} />}
                    {podeNaConta(m) && <AtivacaoBotao membro={m} onFeito={acao} />}
                    {m.acoes?.removerDaOperacao && <RemoverDaOperacaoBotao membro={m} onFeito={acao} />}
                    {!podeNaOperacao(m) && (
                      <span
                        title={m.acoes?.motivo ?? undefined}
                        className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] max-w-[16rem] text-right"
                      >
                        Conta de quem responde pelo grupo — só outro dono do grupo altera.
                      </span>
                    )}
                    {podeNaOperacao(m) && !podeNaConta(m) && (
                      <span
                        title={m.acoes?.motivo ?? undefined}
                        className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] max-w-[16rem] text-right"
                      >
                        Senha e desativação valem nas outras operações desta pessoa — só quem
                        responde por todas elas as altera.
                      </span>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>
    </AppShell>
  );
}

/**
 * Reset de senha.
 *
 * A senha nova é digitada e some da tela ao confirmar. Fica visível enquanto
 * se digita de propósito: o gestor precisa ler para entregar a quem vai usar,
 * e esconder atrás de asteriscos só levaria a erro de digitação numa senha que
 * a própria pessoa vai trocar no primeiro acesso.
 */
function ResetSenhaBotao({
  membro,
  onFeito,
}: {
  membro: MembroDaEquipe;
  onFeito: (fn: () => Promise<unknown>, mensagem: string) => Promise<void>;
}) {
  const [aberto, setAberto] = useState(false);
  const [senha, setSenha] = useState('');

  if (!aberto) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setAberto(true)}>
        Resetar senha
      </Button>
    );
  }

  return (
    <div className="flex gap-2 items-center">
      <Input
        value={senha}
        onChange={(e) => setSenha(e.target.value)}
        placeholder="Senha provisória"
        aria-label={`Senha provisória de ${membro.displayName}`}
        className="w-44"
      />
      <Button
        size="sm"
        onClick={() =>
          void onFeito(
            () => coreApi.resetTeamMemberPassword(membro.id, senha),
            'Senha provisória definida. As sessões abertas da pessoa caíram na hora; ela troca a senha no primeiro acesso.',
          ).then(() => {
            setSenha('');
            setAberto(false);
          })
        }
      >
        Confirmar
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setSenha('');
          setAberto(false);
        }}
      >
        Cancelar
      </Button>
    </div>
  );
}

/**
 * Desativar / Reativar.
 *
 * Desativar pede confirmação e DIZ O ALCANCE (GAP-PRD-152): `active` é da
 * conta, não do vínculo, e corta a pessoa em todas as operações dela. Quem
 * clicava achando que tirava o técnico só desta loja tirava das duas. A
 * confirmação é um bloco na tela, como nas outras telas do sistema, e não um
 * `confirm()` do navegador — o que precisa ser lido aqui é o alcance.
 *
 * E diz QUANDO (GAP-PRD-053): o servidor confere a conta a cada requisição, e
 * a sessão aberta da pessoa cai na seguinte — não "em até uma hora", que era
 * a janela do token antes da conferência.
 *
 * Reativar não pergunta: devolver o acesso não tira nada de ninguém.
 */
function AtivacaoBotao({
  membro,
  onFeito,
}: {
  membro: MembroDaEquipe;
  onFeito: (fn: () => Promise<unknown>, mensagem: string) => Promise<void>;
}) {
  const [confirmando, setConfirmando] = useState(false);

  if (!membro.active) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void onFeito(() => coreApi.setTeamMemberActive(membro.id, true), 'Acesso reativado.')}
      >
        Reativar
      </Button>
    );
  }

  if (!confirmando) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirmando(true)}>
        Desativar
      </Button>
    );
  }

  return (
    <div role="group" aria-label={`Desativar ${membro.displayName}`} className="flex flex-col gap-2 items-end">
      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text)] text-right max-w-[20rem]">
        Desativar corta o acesso de {membro.displayName} {alcanceDoCorte(membro)}.
        {' '}A sessão que estiver aberta cai na hora, em qualquer aparelho.
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() =>
            void onFeito(
              () => coreApi.setTeamMemberActive(membro.id, false),
              'Acesso desativado. A sessão que estava aberta caiu na hora.',
            ).then(() => setConfirmando(false))
          }
        >
          Confirmar desativação
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmando(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/**
 * Remover desta operação — a alavanca do VÍNCULO (GAP-PRD-152).
 *
 * Só aparece quando o servidor diz que cabe: a pessoa entra em outra operação
 * (o último vínculo não se remove — para isso existe Desativar) e quem age
 * alcança o perfil que ela tem aqui.
 */
function RemoverDaOperacaoBotao({
  membro,
  onFeito,
}: {
  membro: MembroDaEquipe;
  onFeito: (fn: () => Promise<unknown>, mensagem: string) => Promise<void>;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const outras = membro.acoes?.outrasOperacoes ?? 0;

  if (!confirmando) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirmando(true)}>
        Remover desta operação
      </Button>
    );
  }

  return (
    <div
      role="group"
      aria-label={`Remover ${membro.displayName} desta operação`}
      className="flex flex-col gap-2 items-end"
    >
      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text)] text-right max-w-[20rem]">
        {membro.displayName} deixa de entrar nesta operação.{' '}
        {outras === 1 ? 'O acesso à outra operação continua' : `O acesso às outras ${outras} operações continua`},
        com a mesma senha. A sessão aberta nesta operação cai na hora.
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() =>
            void onFeito(
              () => equipeApi.removerDaOperacao(membro.id),
              `${membro.displayName} foi removido desta operação.`,
            ).then(() => setConfirmando(false))
          }
        >
          Confirmar remoção
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmando(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/** Cadastro e edição. O login não muda depois de criado — é a identidade. */
function EquipeForm({
  membro,
  oficinas,
  perfis,
  onCancelar,
  onSalvo,
}: {
  membro: MembroDaEquipe | null;
  oficinas: Oficina[];
  perfis: string[];
  onCancelar: () => void;
  onSalvo: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(membro?.displayName ?? '');
  const [login, setLogin] = useState(membro?.login ?? '');
  const [email, setEmail] = useState(membro?.email ?? '');
  const [profileCode, setProfileCode] = useState(membro?.profileCode ?? 'mecanico');
  const [password, setPassword] = useState('');
  const [workshopIds, setWorkshopIds] = useState<string[]>(
    membro?.workshops.map((w) => w.id) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * O login digitado já é de uma conta do grupo. Cadastrar de novo é recusado
   * (409) de propósito — sobrescreveria a senha de outra pessoa —, mas a
   * intenção costuma ser legítima: a pessoa já trabalha em outra operação e
   * vai trabalhar aqui também. A tela oferece o caminho certo para isso.
   */
  const [loginJaExiste, setLoginJaExiste] = useState(false);

  /** Nome e e-mail são da conta; fora do alcance, a tela não os oferece. */
  const contaForaDoAlcance = Boolean(membro) && !podeNaConta(membro!);

  const exigeOficina = PERFIS_DE_OFICINA.has(profileCode);

  /**
   * O perfil atual não está entre os atribuíveis (é `admin_geral`, por
   * exemplo). Como o select não o contém, salvar mandaria outro valor e
   * REBAIXARIA a pessoa em silêncio — bastaria abrir "Editar" para trocar o
   * telefone. Nesse caso o perfil vira texto e não é enviado.
   */
  const perfilForaDaLista = Boolean(membro) && !perfis.includes(membro!.profileCode);

  const darAcessoAContaExistente = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await equipeApi.darAcessoAContaExistente({ login, profileCode, workshopIds });
      setLoginJaExiste(false);
      await onSalvo();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao dar acesso.');
    } finally {
      setBusy(false);
    }
  }, [login, profileCode, workshopIds, onSalvo]);

  const alternarOficina = (id: string) =>
    setWorkshopIds((atual) =>
      atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id],
    );

  const salvar = useCallback(async () => {
    // Antecipa a regra do servidor para não perder a ficha preenchida.
    if (exigeOficina && workshopIds.length === 0) {
      setError('Perfil de oficina exige ao menos uma oficina vinculada.');
      return;
    }
    setBusy(true);
    setError(null);
    setLoginJaExiste(false);
    try {
      if (membro) {
        await coreApi.updateTeamMember(membro.id, {
          displayName,
          email: email || null,
          profileCode: perfilForaDaLista ? undefined : profileCode,
          workshopIds,
        });
      } else {
        await coreApi.createTeamMember({
          login,
          displayName,
          email: email || null,
          profileCode,
          password,
          workshopIds,
        });
      }
      await onSalvo();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
      setLoginJaExiste(!membro && err instanceof ApiRequestError && err.code === 'CORE_LOGIN_TAKEN');
    } finally {
      setBusy(false);
    }
  }, [
    membro,
    displayName,
    login,
    email,
    profileCode,
    password,
    workshopIds,
    exigeOficina,
    perfilForaDaLista,
    onSalvo,
  ]);

  return (
    <Card
      title={membro ? `Editar ${membro.displayName}` : 'Nova pessoa'}
      subtitle={
        membro
          ? 'O login não muda: é a identidade da pessoa no histórico das OS.'
          : 'A senha definida aqui é provisória — quem receber troca no primeiro acesso.'
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="Nome"
            required
            hint={
              contaForaDoAlcance
                ? 'Vale nas outras operações desta pessoa — só quem responde por todas altera.'
                : undefined
            }
          >
            {(props) => (
              <Input
                {...props}
                value={displayName}
                disabled={contaForaDoAlcance}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Login"
            required
            hint={membro ? 'Não pode ser alterado.' : 'Usado para entrar no sistema.'}
          >
            {(props) => (
              <Input
                {...props}
                value={login}
                disabled={Boolean(membro)}
                onChange={(e) => setLogin(e.target.value)}
              />
            )}
          </Field>
          <Field label="E-mail">
            {(props) => (
              <Input
                {...props}
                type="email"
                value={email}
                disabled={contaForaDoAlcance}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Perfil"
            required={!perfilForaDaLista}
            hint={
              perfilForaDaLista
                ? 'Este perfil não é alterável por esta tela e será preservado.'
                : membro
                  ? 'O perfil novo vale já na próxima ação da pessoa, sem ela precisar sair e entrar.'
                  : undefined
            }
          >
            {(props) =>
              perfilForaDaLista ? (
                <p
                  {...props}
                  className="h-11 flex items-center px-3 rounded-[var(--gs-radius)]
                    bg-[var(--gs-surface-hover)] text-[length:var(--gs-text-base)] m-0"
                >
                  {PERFIL_ROTULO[membro!.profileCode] ?? membro!.profileCode}
                </p>
              ) : (
                <select
                  {...props}
                  value={profileCode}
                  onChange={(e) => setProfileCode(e.target.value)}
                  className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                    bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
                >
                  {perfis.map((p) => (
                    <option key={p} value={p}>
                      {PERFIL_ROTULO[p] ?? p}
                    </option>
                  ))}
                </select>
              )
            }
          </Field>
        </div>

        {!membro && (
          <Field
            label="Senha provisória"
            required
            hint="Mínimo de 8 caracteres. A pessoa troca no primeiro acesso."
          >
            {(props) => (
              <Input
                {...props}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            )}
          </Field>
        )}

        <Field
          label="Oficinas"
          required={exigeOficina}
          hint={
            exigeOficina
              ? 'Sem vínculo, a pessoa entra e não vê OS nenhuma.'
              : 'Opcional para quem não atende oficina.'
          }
        >
          {({ id, 'aria-describedby': describedBy }) =>
            oficinas.length === 0 ? (
              <p
                id={id}
                aria-describedby={describedBy}
                className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0"
              >
                Nenhuma oficina nesta operação.
              </p>
            ) : (
              <div id={id} role="group" aria-describedby={describedBy} className="flex flex-col gap-2">
                {oficinas.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-[length:var(--gs-text-base)]">
                    <input
                      type="checkbox"
                      checked={workshopIds.includes(o.id)}
                      onChange={() => alternarOficina(o.id)}
                      className="w-4 h-4 accent-[var(--gs-purple-700)]"
                    />
                    {o.name}
                  </label>
                ))}
              </div>
            )
          }
        </Field>

        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        {loginJaExiste && (
          <div className="flex flex-col gap-2 px-3 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]">
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text)]">
              Se esta pessoa já trabalha em outra operação do grupo, dê a ela acesso a esta com o
              perfil e as oficinas escolhidos acima. A senha dela não muda — e a senha provisória
              digitada aqui não é usada.
            </span>
            <div>
              <Button
                size="sm"
                loading={busy}
                onClick={() => void darAcessoAContaExistente()}
              >
                Dar acesso a esta conta nesta operação
              </Button>
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <Button loading={busy} onClick={() => void salvar()}>
            {membro ? 'Salvar alterações' : 'Cadastrar'}
          </Button>
          <Button variant="ghost" onClick={onCancelar}>
            Cancelar
          </Button>
        </div>
      </div>
    </Card>
  );
}
