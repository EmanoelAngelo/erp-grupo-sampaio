/**
 * ============================================================================
 * CAIXAS E TERMINAIS — Configurações › Caixas e terminais
 * (GAP-PRD-039, GAP-PRD-146, GAP-PRD-150)
 * ============================================================================
 *
 * ## O que faltava
 *
 * `core_terminals` não tinha escritor e o `docs/OPERATIONS.md` falava em
 * "Criar PDV" numa tela que não existia. O efeito era uma gaveta por empresa:
 * o segundo operador vendia na gaveta do primeiro. E o token de dispositivo —
 * o único caminho sem senha para o computador do caixa — só se criava com
 * `curl`.
 *
 * ## O que esta tela faz
 *
 * 1. CAIXAS: o gerente cadastra, renomeia, desativa (com motivo) e reativa.
 *    Cada caixa tem a sua gaveta; a lista diz qual está aberta, por quem e
 *    desde quando.
 * 2. ESTE COMPUTADOR: qual caixa ele é (a escolha que o PDV guarda) e se ele
 *    tem o token de dispositivo guardado.
 * 3. ACESSO SEM SENHA: quem responde pelo grupo registra o computador de um
 *    caixa (token mostrado UMA vez, com "guardar neste computador"), vê o
 *    último uso de cada um e revoga quando a máquina some. É o mesmo alcance
 *    do servidor (`api.device.*` = admin_geral e gestor): o gerente vê a
 *    explicação, não um botão que responderia 403.
 */
import { useCallback, useEffect, useState } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type TeamMember } from '@/lib/api/core';
import { dataHoraBR } from '@/lib/datas';
import {
  caixaDesteComputador,
  diaBr,
  guardarCaixaDesteComputador,
  guardarTokenNesteComputador,
  terminaisApi,
  tokenDesteComputador,
  type TerminalDeCaixa,
  type TokenDeDispositivo,
} from '@/lib/api/terminais';

const mensagemDe = (err: unknown, padrao: string) =>
  err instanceof ApiRequestError ? err.message : padrao;

export default function TerminaisPage() {
  const session = useSession();
  const empresa = session?.company.id ?? null;
  const [caixas, setCaixas] = useState<TerminalDeCaixa[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setCaixas(await terminaisApi.listar());
    } catch (err) {
      // Nulo, e não lista vazia: "nenhum caixa" depois de uma falha levaria o
      // gerente a cadastrar de novo o que já existe.
      setCaixas(null);
      setErro(mensagemDe(err, 'Não foi possível carregar os caixas.'));
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Caixas e terminais']}
        title="Caixas e terminais"
        subtitle="Cada caixa tem a sua gaveta, o seu fundo, a sua sangria e o seu fechamento. Dois operadores ao mesmo tempo, sem misturar dinheiro."
      />

      {aviso && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {aviso}
        </div>
      )}
      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      <CaixasDaOperacao
        caixas={caixas}
        onMudou={(texto) => {
          setAviso(texto);
          void carregar();
        }}
      />

      <div className="mt-6">
        <EsteComputador empresa={empresa} caixas={caixas} />
      </div>

      <div className="mt-6">
        <AcessoSemSenha caixas={caixas} onMudou={() => void carregar()} />
      </div>
    </AppShell>
  );
}

// ============================================================================
// 1. OS CAIXAS
// ============================================================================

function CaixasDaOperacao({
  caixas,
  onMudou,
}: {
  caixas: TerminalDeCaixa[] | null;
  onMudou: (texto: string) => void;
}) {
  const [nome, setNome] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [renomeando, setRenomeando] = useState<{ id: string; nome: string } | null>(null);
  const [desativando, setDesativando] = useState<TerminalDeCaixa | null>(null);

  const cadastrar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      const novo = await terminaisApi.criar(nome);
      setNome('');
      onMudou(`Caixa "${novo.name}" cadastrado (código ${novo.code}). No PDV, escolha-o no computador que vai operá-lo.`);
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível cadastrar o caixa.'));
    } finally {
      setOcupado(false);
    }
  };

  const salvarNome = async () => {
    if (!renomeando) return;
    setErro(null);
    try {
      const salvo = await terminaisApi.renomear(renomeando.id, renomeando.nome);
      setRenomeando(null);
      onMudou(`Caixa renomeado para "${salvo.name}".`);
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível renomear.'));
    }
  };

  const reativar = async (c: TerminalDeCaixa) => {
    setErro(null);
    try {
      await terminaisApi.ativar(c.id);
      onMudou(`Caixa "${c.name}" reativado.`);
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível reativar.'));
    }
  };

  return (
    <Card
      title="Caixas desta operação"
      subtitle="Sem nenhum caixa cadastrado, a operação tem uma gaveta única — como sempre foi. Cadastrado o primeiro, toda gaveta passa a abrir num caixa."
    >
      <form
        className="flex flex-wrap items-end gap-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          void cadastrar();
        }}
      >
        <label className="flex flex-col gap-1.5 flex-1 min-w-[240px]">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Nome do caixa
          </span>
          <Input
            aria-label="Nome do caixa"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder='Ex.: "Caixa 2 — balcão"'
          />
        </label>
        <Button type="submit" loading={ocupado} disabled={!nome.trim()}>
          Cadastrar caixa
        </Button>
      </form>

      {erro && (
        <p role="alert" className="m-0 mb-3 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
          {erro}
        </p>
      )}

      {caixas === null ? (
        <p role="status" className="text-[var(--gs-muted)]">Carregando…</p>
      ) : caixas.length === 0 ? (
        <EmptyState
          title="Nenhum caixa cadastrado"
          description="A operação trabalha com a gaveta única. Cadastre um caixa por ponto de venda para cada um ter a sua gaveta."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                <th className="py-2.5 pr-4 font-semibold">Caixa</th>
                <th className="py-2.5 pr-4 font-semibold">Situação</th>
                <th className="py-2.5 pr-4 font-semibold">Gaveta</th>
                <th className="py-2.5 pr-4 font-semibold">Computadores sem senha</th>
                <th className="py-2.5 font-semibold text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {caixas.map((c) => (
                <tr key={c.id} className="border-b border-[var(--gs-border)] last:border-0 align-top">
                  <td className="py-3 pr-4">
                    {renomeando?.id === c.id ? (
                      <div className="flex gap-2 items-center">
                        <Input
                          aria-label={`Novo nome de ${c.name}`}
                          value={renomeando.nome}
                          onChange={(e) => setRenomeando({ id: c.id, nome: e.target.value })}
                        />
                        <Button size="sm" onClick={() => void salvarNome()} disabled={!renomeando.nome.trim()}>
                          Salvar
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenomeando(null)}>
                          Cancelar
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="font-semibold">{c.name}</div>
                        <div className="font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{c.code}</div>
                      </>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {c.active ? <Badge tone="success">Ativo</Badge> : <Badge tone="neutral">Desativado</Badge>}
                    {!c.active && c.deactivationReason && (
                      <div className="mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                        Desativado em {dataHoraBR(c.deactivatedAt)} — {c.deactivationReason}
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {c.caixaAberto ? (
                      <>
                        <span>
                          Aberta{c.caixaAberto.openedByName ? ` por ${c.caixaAberto.openedByName}` : ''} em{' '}
                          {dataHoraBR(c.caixaAberto.openedAt)}
                        </span>
                        {c.caixaAberto.deOutroDia && (
                          <div className="mt-1">
                            <Badge tone="warning">
                              De outro dia — desde {diaBr(c.caixaAberto.deOutroDia.abertaNoDia)}
                            </Badge>
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-[var(--gs-muted)]">Fechada</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">{c.tokensAtivos}</td>
                  <td className="py-3 text-right whitespace-nowrap">
                    <span className="inline-flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setRenomeando({ id: c.id, nome: c.name })}>
                        Renomear
                      </Button>
                      {c.active ? (
                        <Button size="sm" variant="danger" onClick={() => setDesativando(c)}>
                          Desativar
                        </Button>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => void reativar(c)}>
                          Reativar
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {desativando && (
        <DialogoDeMotivo
          titulo={`Desativar — ${desativando.name}`}
          explicacao={
            'Desativado, o caixa não abre gaveta e os computadores registrados nele deixam de entrar sem '
            + 'senha até ele ser reativado. As vendas e os turnos antigos continuam apontando para ele. '
            + 'Com a gaveta aberta o servidor recusa: feche o turno antes.'
          }
          rotulo="Desativar"
          placeholder="Ex.: computador foi para o conserto"
          onClose={() => setDesativando(null)}
          onConfirmar={async (motivo) => {
            await terminaisApi.desativar(desativando.id, motivo);
            const nomeDele = desativando.name;
            setDesativando(null);
            onMudou(`Caixa "${nomeDele}" desativado.`);
          }}
        />
      )}
    </Card>
  );
}

// ============================================================================
// 2. ESTE COMPUTADOR
// ============================================================================

function EsteComputador({
  empresa,
  caixas,
}: {
  empresa: string | null;
  caixas: TerminalDeCaixa[] | null;
}) {
  const [escolhido, setEscolhido] = useState<string | null>(() => caixaDesteComputador(empresa));
  const [temToken, setTemToken] = useState<boolean>(() => Boolean(tokenDesteComputador()));
  const ativos = (caixas ?? []).filter((c) => c.active);
  const nomeDoEscolhido = (caixas ?? []).find((c) => c.id === escolhido)?.name ?? null;

  return (
    <Card
      title="Este computador"
      subtitle="O que ESTA máquina sabe de si. Fica guardado no navegador dela, e não na conta de quem está logado."
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 max-w-md">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Caixa que este computador opera no PDV
          </span>
          <select
            aria-label="Caixa deste computador"
            value={escolhido ?? ''}
            disabled={!empresa || ativos.length === 0}
            onChange={(e) => {
              const valor = e.target.value || null;
              if (empresa) guardarCaixaDesteComputador(empresa, valor);
              setEscolhido(valor);
            }}
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
          >
            <option value="">{ativos.length === 0 ? 'Nenhum caixa ativo' : 'Escolher no PDV'}</option>
            {ativos.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            {nomeDoEscolhido
              ? `O PDV deste computador abre e vende na gaveta do "${nomeDoEscolhido}".`
              : 'Sem escolha, o PDV pergunta qual caixa é na hora de abrir a gaveta.'}
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          {temToken ? (
            <>
              <Badge tone="success">Registrado como terminal sem senha</Badge>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                A tela de login mostra "Entrar no PDV deste terminal" na aba do PDV.
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  guardarTokenNesteComputador(null);
                  setTemToken(false);
                }}
              >
                Esquecer o token deste computador
              </Button>
            </>
          ) : (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Este computador entra no PDV com login e senha.
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

// ============================================================================
// 3. ACESSO SEM SENHA (TOKEN DE DISPOSITIVO)
// ============================================================================

function AcessoSemSenha({
  caixas,
  onMudou,
}: {
  caixas: TerminalDeCaixa[] | null;
  onMudou: () => void;
}) {
  // O MESMO alcance das rotas `/auth/device*` (`api.device.*`): só quem
  // responde pelo grupo. `useHasProfile()` sem argumento é exatamente isso.
  const podeRegistrar = useHasProfile();
  const [tokens, setTokens] = useState<TokenDeDispositivo[] | null>(null);
  const [usuarios, setUsuarios] = useState<TeamMember[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [form, setForm] = useState({ userId: '', terminalId: '', label: '' });
  const [ocupado, setOcupado] = useState(false);
  const [novo, setNovo] = useState<{ token: string; label: string; guardado: boolean } | null>(null);
  const [revogando, setRevogando] = useState<TokenDeDispositivo | null>(null);

  const carregar = useCallback(async () => {
    try {
      setTokens(await terminaisApi.dispositivos());
    } catch (err) {
      setTokens(null);
      setErro(mensagemDe(err, 'Não foi possível listar os computadores registrados.'));
    }
  }, []);

  useEffect(() => {
    if (!podeRegistrar) return;
    void carregar();
    void coreApi
      .listTeam()
      // O token é do PDV: a lista oferece quem opera caixa. Um token para
      // perfil de gestão seria uma sessão de gestão sem senha no balcão.
      .then((equipe) => setUsuarios(equipe.filter((u) => u.active && u.profileCode.startsWith('operador_caixa'))))
      .catch(() => setUsuarios([]));
  }, [podeRegistrar, carregar]);

  if (!podeRegistrar) {
    return (
      <Card title="Acesso sem senha (token do computador)">
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          Registrar um computador para entrar no PDV sem digitar senha — e revogar quando a máquina
          some — é feito por quem responde pelo grupo (administrador geral ou gestor).
        </p>
      </Card>
    );
  }

  const registrar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      const r = await terminaisApi.registrarDispositivo({
        userId: form.userId,
        label: form.label,
        terminalId: form.terminalId || null,
      });
      setNovo({ token: r.deviceToken, label: r.label, guardado: false });
      setForm({ userId: '', terminalId: '', label: '' });
      await carregar();
      onMudou();
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível registrar o computador.'));
    } finally {
      setOcupado(false);
    }
  };

  const ativos = (caixas ?? []).filter((c) => c.active);

  return (
    <Card
      title="Acesso sem senha (token do computador)"
      subtitle="O computador do caixa guarda um código opaco e entra no PDV sem senha. O código aparece UMA vez; o servidor guarda só o resumo dele. Revogue quando a máquina sair da loja."
    >
      {erro && (
        <p role="alert" className="m-0 mb-3 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
          {erro}
        </p>
      )}

      {novo && (
        <div
          role="status"
          data-testid="token-novo"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] flex flex-col gap-2"
        >
          <strong className="text-[var(--gs-warning)]">
            Código do computador "{novo.label}" — aparece só agora.
          </strong>
          <code className="break-all bg-[var(--gs-surface)] px-2 py-1 rounded">{novo.token}</code>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                guardarTokenNesteComputador(novo.token);
                setNovo({ ...novo, guardado: true });
              }}
            >
              Guardar neste computador
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void navigator.clipboard?.writeText(novo.token).catch(() => undefined)}
            >
              Copiar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNovo(null)}>
              Já guardei — esconder
            </Button>
          </div>
          {novo.guardado && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
              Guardado. Saia e, na tela de login, aba PDV, use "Entrar no PDV deste terminal".
            </span>
          )}
        </div>
      )}

      <form
        className="grid gap-3 sm:grid-cols-4 items-end mb-5"
        onSubmit={(e) => {
          e.preventDefault();
          void registrar();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">Usuário do caixa</span>
          <select
            aria-label="Usuário do caixa"
            value={form.userId}
            onChange={(e) => setForm({ ...form, userId: e.target.value })}
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
          >
            <option value="">{usuarios.length === 0 ? 'Nenhum usuário de caixa' : 'Escolha'}</option>
            {usuarios.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} ({u.login})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">Caixa</span>
          <select
            aria-label="Caixa do computador"
            value={form.terminalId}
            onChange={(e) => setForm({ ...form, terminalId: e.target.value })}
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
          >
            <option value="">{ativos.length === 0 ? 'Gaveta única (sem caixa)' : 'Escolha'}</option>
            {ativos.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">Nome do computador</span>
          <Input
            aria-label="Nome do computador"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="Ex.: micro do balcão 2"
          />
        </label>
        <Button
          type="submit"
          loading={ocupado}
          disabled={!form.userId || !form.label.trim() || (ativos.length > 0 && !form.terminalId)}
        >
          Registrar computador
        </Button>
      </form>

      {tokens === null ? (
        <p role="status" className="text-[var(--gs-muted)]">Carregando…</p>
      ) : tokens.length === 0 ? (
        <EmptyState
          title="Nenhum computador registrado"
          description="Todo computador entra no PDV com login e senha."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                <th className="py-2.5 pr-4 font-semibold">Computador</th>
                <th className="py-2.5 pr-4 font-semibold">Usuário</th>
                <th className="py-2.5 pr-4 font-semibold">Caixa</th>
                <th className="py-2.5 pr-4 font-semibold">Último uso</th>
                <th className="py-2.5 pr-4 font-semibold">Situação</th>
                <th className="py-2.5 font-semibold text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-b border-[var(--gs-border)] last:border-0 align-top">
                  <td className="py-3 pr-4 font-semibold">{t.label ?? '—'}</td>
                  <td className="py-3 pr-4">
                    {t.userDisplayName} <span className="text-[var(--gs-muted)]">({t.userLogin})</span>
                  </td>
                  <td className="py-3 pr-4">
                    {t.terminalName ?? <span className="text-[var(--gs-muted)]">Gaveta única</span>}
                    {t.terminalActive === false && (
                      <div className="mt-1">
                        <Badge tone="warning">Caixa desativado — não entra</Badge>
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-4">{t.lastUsedAt ? dataHoraBR(t.lastUsedAt) : 'Nunca'}</td>
                  <td className="py-3 pr-4">
                    {t.revoked ? <Badge tone="neutral">Revogado</Badge> : <Badge tone="success">Ativo</Badge>}
                  </td>
                  <td className="py-3 text-right">
                    {!t.revoked && (
                      <Button size="sm" variant="danger" onClick={() => setRevogando(t)}>
                        Revogar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revogando && (
        <DialogoDeMotivo
          titulo={`Revogar — ${revogando.label ?? 'computador'}`}
          explicacao="Revogado, o computador para de entrar sem senha no próximo login. A linha fica na lista para a auditoria; não há como desfazer — registre de novo se precisar."
          rotulo="Revogar"
          placeholder="Ex.: computador trocado"
          onClose={() => setRevogando(null)}
          onConfirmar={async (motivo) => {
            await terminaisApi.revogarDispositivo(revogando.id, motivo);
            setRevogando(null);
            await carregar();
            onMudou();
          }}
        />
      )}
    </Card>
  );
}

// ============================================================================

function DialogoDeMotivo({
  titulo,
  explicacao,
  rotulo,
  placeholder,
  onClose,
  onConfirmar,
}: {
  titulo: string;
  explicacao: string;
  rotulo: string;
  placeholder: string;
  onClose: () => void;
  onConfirmar: (motivo: string) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const confirmar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      await onConfirmar(motivo.trim());
    } catch (err) {
      // A recusa do servidor (gaveta aberta, motivo curto) aparece como veio.
      setErro(mensagemDe(err, 'Não foi possível concluir.'));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={titulo}
    >
      <div className="w-full max-w-xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] m-0">{titulo}</h2>
        </header>
        <div className="px-6 py-5 flex flex-col gap-4">
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">{explicacao}</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">Motivo</span>
            <Input aria-label="Motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={placeholder} />
          </label>
          {erro && (
            <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="danger" loading={ocupado} disabled={motivo.trim().length < 3} onClick={() => void confirmar()}>
              {rotulo}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
