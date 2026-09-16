/**
 * ============================================================================
 * Fiscal › Operações fiscais — o que o contador informa, por empresa
 * ============================================================================
 *
 * ## O DEFEITO QUE ESTA TELA FECHA (P0 fiscal da Preço Justo)
 *
 * O servidor tinha tudo: `core_fiscal_operations` guarda a natureza da
 * operação, o CFOP da devolução, o grupo tributário da devolução, o PRAZO DE
 * CANCELAMENTO aceito pela UF e a confirmação do contador; `listarOperacoes`
 * lê; `gravarOperacao` escreve com trilha; `pendenciasContabeis` lista tudo o
 * que ainda depende do contador. As três rotas existiam e estavam no mapa de
 * capabilities.
 *
 * E NENHUMA TELA AS CHAMAVA. As mensagens do sistema apontavam para dois
 * lugares que não existiam no navegador:
 *
 *   - `exigirOperacaoConfirmadaEmProducao` recusa a devolução em produção com
 *     "Confirme em Fiscal › Operações fiscais";
 *   - o item `accountant_pending` do checklist manda ler a lista completa em
 *     "Fiscal › Pendências contábeis".
 *
 * Quem batesse nas duas ficava sem caminho: o prazo de cancelamento, a
 * natureza da operação e o CFOP da devolução só podiam ser gravados por fora
 * do sistema. Beco sem saída é pior que campo faltando — o campo faltando pelo
 * menos se vê.
 *
 * ## O QUE ESTA TELA NÃO FAZ
 *
 * Não inventa valor nenhum. O prazo em branco continua em branco (e a SEFAZ
 * decide); a confirmação do contador é um gesto explícito de quem falou com
 * ele. E não aceita CFOP nem grupo tributário nas operações de VENDA: esses
 * moram no grupo tributário de cada produto, e uma segunda cópia aqui
 * divergiria dele — o servidor recusa, e a tela nem oferece.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { useCan } from '@/hooks/useCan';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type GrupoTributario } from '@/lib/api/core';
import {
  fiscalOperacoesApi,
  PRAZO_DE_CANCELAMENTO_MAXIMO_MIN,
  type ParametrosDaOperacao,
  type PendenciaContabil,
} from '@/lib/api/fiscalOperacoes';
import { dataHoraBR } from '@/lib/datas';

/**
 * O QUE CADA PENDÊNCIA IMPEDE — o eixo que decide a ordem de leitura.
 *
 * "Impede a emissão" é uma venda recusada hoje, no balcão; "impede a produção"
 * é uma nota que sai em homologação e não vale; "nada" é confirmação que o
 * contador ainda deve, e que não para ninguém. Misturar os três numa lista
 * plana é o que faz o gestor tratar tudo como urgente — e depois nada.
 */
const IMPEDE_ROTULO: Record<PendenciaContabil['impede'], { texto: string; tom: 'danger' | 'warning' | 'neutral' }> = {
  emissao: { texto: 'IMPEDE A EMISSÃO', tom: 'danger' },
  producao: { texto: 'IMPEDE A PRODUÇÃO', tom: 'warning' },
  nada: { texto: 'CONFIRMAÇÃO PENDENTE', tom: 'neutral' },
};

const ORDEM_DO_IMPEDIMENTO: PendenciaContabil['impede'][] = ['emissao', 'producao', 'nada'];

/** Minutos em palavras de quem lê: "1440 min" não diz "um dia". */
function prazoEmPalavras(minutos: number): string {
  if (minutos % (24 * 60) === 0) {
    const dias = minutos / (24 * 60);
    return `${dias} dia(s)`;
  }
  if (minutos % 60 === 0) return `${minutos / 60} hora(s)`;
  return `${minutos} minuto(s)`;
}

interface Rascunho {
  natOp: string;
  cfopInterno: string;
  cfopInterestadual: string;
  grupoTributario: string;
  prazo: string;
  confirmada: boolean;
  observacao: string;
}

function rascunhoDe(op: ParametrosDaOperacao): Rascunho {
  return {
    natOp: op.natOp ?? '',
    cfopInterno: op.cfopInterno ?? '',
    cfopInterestadual: op.cfopInterestadual ?? '',
    grupoTributario: op.grupoTributario ?? '',
    prazo: op.prazoCancelamentoMinutos === null ? '' : String(op.prazoCancelamentoMinutos),
    confirmada: op.confirmadaPeloContador,
    observacao: op.observacao ?? '',
  };
}

export default function FiscalOperacoesPage() {
  const [operacoes, setOperacoes] = useState<ParametrosDaOperacao[] | null>(null);
  const [pendencias, setPendencias] = useState<PendenciaContabil[] | null>(null);
  const [grupos, setGrupos] = useState<GrupoTributario[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /*
    LER É DA GERÊNCIA; GRAVAR É DE QUEM TEM `fiscal.policy.manage`.

    `GET /core/fiscal/operacoes` e `GET /core/fiscal/pendencias-contabeis` são
    `fiscal.view` (admin_geral, gestor, gerente_loja e gerente_oficina); o
    `PUT` é `fiscal.policy.manage`, que hoje só os dois primeiros têm — é a
    mesma régua da política de contingência, porque é o que libera a devolução
    em produção. Oferecer o botão de gravar a quem não a tem seria a porta que
    bate na cara: ele clicaria e levaria 403.

    Pela CAPABILITY, e não pelo código do perfil: é a pergunta que o servidor
    faz (`requireCapability`), e é a única que continua certa quando o acesso
    de alguém é personalizado na tela de Usuários.
  */
  const podeGravar = useCan('fiscal.policy.manage');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const [ops, pends] = await Promise.all([
        fiscalOperacoesApi.listar(),
        fiscalOperacoesApi.pendencias(),
      ]);
      setOperacoes(ops);
      setPendencias(pends);
    } catch (err) {
      setOperacoes(null);
      setPendencias(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar as operações fiscais.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /*
    OS GRUPOS SÃO ACESSÓRIOS: a devolução escolhe um deles, e a falta da lista
    não pode apagar a tela inteira. Por isso a leitura é separada e o erro dela
    só deixa o seletor vazio (com a dica de onde cadastrar).
  */
  useEffect(() => {
    void (async () => {
      try {
        setGrupos(await coreApi.listTaxGroups());
      } catch {
        setGrupos([]);
      }
    })();
  }, []);

  const porImpedimento = useMemo(() => {
    const mapa = new Map<PendenciaContabil['impede'], PendenciaContabil[]>();
    for (const chave of ORDEM_DO_IMPEDIMENTO) mapa.set(chave, []);
    for (const p of pendencias ?? []) mapa.get(p.impede)?.push(p);
    return mapa;
  }, [pendencias]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Fiscal', 'Operações fiscais']}
        title="Operações fiscais e pendências contábeis"
        subtitle={
          'Natureza da operação, CFOP da devolução, prazo de cancelamento e a confirmação do '
          + 'contador — por empresa. Nada aqui é inventado pelo sistema.'
        }
      />

      {aviso && (
        <p
          role="status"
          className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-success)]"
        >
          {aviso}
        </p>
      )}
      {erro && (
        <p
          role="alert"
          className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      <div className="flex flex-col gap-5">
        <Card
          title="Pendências contábeis"
          subtitle="O que ainda depende do contador nesta operação, e o que cada ponto impede."
        >
          {pendencias && pendencias.length === 0 && (
            <EmptyState
              title="Nada pendente com o contador"
              description="Todas as operações estão confirmadas e nenhum grupo tributário tem campo em aberto."
            />
          )}
          {pendencias && pendencias.length > 0 && (
            <div className="flex flex-col gap-4">
              {ORDEM_DO_IMPEDIMENTO.map((chave) => {
                const lista = porImpedimento.get(chave) ?? [];
                if (lista.length === 0) return null;
                const selo = IMPEDE_ROTULO[chave];
                return (
                  <section key={chave} className="flex flex-col gap-2">
                    <h3 className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                      <Badge tone={selo.tom}>{selo.texto}</Badge>
                      <span className="ml-2">{lista.length} ponto(s)</span>
                    </h3>
                    <ul className="list-none p-0 m-0 flex flex-col gap-3">
                      {lista.map((p) => (
                        <li
                          key={p.chave}
                          className="flex flex-col gap-1 border-l-2 border-[var(--gs-border-strong)] pl-3"
                        >
                          <span className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-purple-900)]">
                            {p.tema}
                          </span>
                          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                            {p.descricao}
                          </span>
                          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] italic">
                            Onde se resolve: {p.onde}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                A tributação de cada mercadoria (CSOSN, pCredSN, CST de PIS/COFINS, CFOP, ST, IPI e
                FCP) é gravada em{' '}
                <Link
                  to="/sistema/produtos/auxiliares?aba=tributarios"
                  className="font-semibold text-[var(--gs-purple-800)] underline"
                >
                  Catálogo › Grupos tributários
                </Link>
                .
              </p>
            </div>
          )}
        </Card>

        {operacoes?.map((op) => (
          <OperacaoCard
            key={op.operacao}
            operacao={op}
            grupos={grupos}
            podeGravar={podeGravar}
            onErro={setErro}
            onGravado={async (mensagem) => {
              setAviso(mensagem);
              setErro(null);
              await carregar();
            }}
          />
        ))}
      </div>
    </AppShell>
  );
}

/**
 * O cartão de UMA operação.
 *
 * A devolução mostra CFOP e grupo tributário; a venda não — e a frase diz por
 * quê, em vez de a tela oferecer um campo que o servidor recusa.
 */
function OperacaoCard({
  operacao,
  grupos,
  podeGravar,
  onGravado,
  onErro,
}: {
  operacao: ParametrosDaOperacao;
  grupos: GrupoTributario[];
  podeGravar: boolean;
  onGravado: (mensagem: string) => Promise<void>;
  onErro: (mensagem: string) => void;
}) {
  const [form, setForm] = useState<Rascunho>(() => rascunhoDe(operacao));
  const [busy, setBusy] = useState(false);
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const devolucao = operacao.operacao.startsWith('devolucao_');

  /*
    O RASCUNHO SEGUE O SERVIDOR (a corrida que a suíte de tela já cobrou uma
    vez): depois de gravar, a página recarrega a lista, e um estado local
    congelado mostraria o valor antigo ao lado da mensagem "gravado". A
    identidade do que veio decide — não o tempo.
  */
  useEffect(() => {
    setForm(rascunhoDe(operacao));
  }, [operacao]);

  const set = <K extends keyof Rascunho>(chave: K) => (valor: Rascunho[K]) =>
    setForm((atual) => ({ ...atual, [chave]: valor }));

  const prazoNumero = form.prazo.trim() === '' ? null : Number(form.prazo.trim());
  const prazoInvalido =
    prazoNumero !== null
    && (!Number.isInteger(prazoNumero) || prazoNumero < 1 || prazoNumero > PRAZO_DE_CANCELAMENTO_MAXIMO_MIN);

  const salvar = useCallback(async () => {
    setBusy(true);
    setErroLocal(null);
    try {
      /*
        NA VENDA, O CFOP E O GRUPO NEM SÃO ENVIADOS. O servidor recusa o par
        com `CORE_FISCAL_OPERATION_SALE_CFOP`, e mandar `null` só para "limpar"
        obrigaria a tela a conhecer a regra de dentro dele. Ausente é ausente:
        o que o corpo não traz continua como está.
      */
      await fiscalOperacoesApi.gravar(operacao.operacao, {
        natOp: form.natOp.trim() || null,
        prazoCancelamentoMinutos: prazoNumero,
        confirmadaPeloContador: form.confirmada,
        observacao: form.observacao.trim() || null,
        ...(devolucao
          ? {
            cfopInterno: form.cfopInterno.trim() || null,
            cfopInterestadual: form.cfopInterestadual.trim() || null,
            grupoTributario: form.grupoTributario.trim() || null,
          }
          : {}),
      });
      await onGravado(`${operacao.rotulo}: parâmetros gravados.`);
    } catch (err) {
      const mensagem = err instanceof ApiRequestError ? err.message : 'Falha ao gravar a operação.';
      setErroLocal(mensagem);
      onErro(mensagem);
    } finally {
      setBusy(false);
    }
  }, [devolucao, form, operacao.operacao, operacao.rotulo, onGravado, onErro, prazoNumero]);

  return (
    <Card
      title={operacao.rotulo}
      subtitle={
        operacao.origem === 'padrao'
          ? 'Nunca gravada: valem os padrões do sistema, e todo padrão não confirmado é pendência contábil.'
          : `Gravada em ${dataHoraBR(operacao.atualizadoEm)}${operacao.atualizadoPor ? ` por ${operacao.atualizadoPor}` : ''}.`
      }
      actions={
        <Badge tone={operacao.confirmadaPeloContador ? 'success' : 'warning'}>
          {operacao.confirmadaPeloContador ? 'CONFIRMADA PELO CONTADOR' : 'NÃO CONFIRMADA'}
        </Badge>
      }
    >
      <div className="flex flex-col gap-4">
        {operacao.pendencias.length > 0 && (
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            {operacao.pendencias.map((p) => (
              <li
                key={p}
                className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] font-semibold"
              >
                • {p}
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="Natureza da operação"
            hint="Vai no <natOp> de cada nota desta operação. Até 60 caracteres."
          >
            {(p) => (
              <Input
                {...p}
                value={form.natOp}
                maxLength={60}
                disabled={!podeGravar}
                onChange={(e) => set('natOp')(e.target.value)}
              />
            )}
          </Field>

          <Field
            label="Prazo de cancelamento (minutos)"
            hint={
              'O que a UF aceita depois da autorização, conforme o contador. Em branco: o sistema '
              + 'não barra nada e a SEFAZ decide.'
            }
            error={
              prazoInvalido
                ? `Informe minutos inteiros de 1 a ${PRAZO_DE_CANCELAMENTO_MAXIMO_MIN} (30 dias).`
                : undefined
            }
          >
            {(p) => (
              <Input
                {...p}
                value={form.prazo}
                inputMode="numeric"
                disabled={!podeGravar}
                onChange={(e) => set('prazo')(e.target.value)}
              />
            )}
          </Field>
        </div>

        {prazoNumero !== null && !prazoInvalido && (
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {prazoEmPalavras(prazoNumero)} depois da autorização. Passado o prazo, o pedido de
            cancelamento é recusado AQUI — antes de falar com a SEFAZ.
          </p>
        )}

        {devolucao ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="CFOP interno" hint={`4 dígitos, começando com ${operacao.direcao === 'entrada' ? '1' : '5'}.`}>
              {(p) => (
                <Input
                  {...p}
                  value={form.cfopInterno}
                  inputMode="numeric"
                  maxLength={4}
                  disabled={!podeGravar}
                  onChange={(e) => set('cfopInterno')(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="CFOP interestadual"
              hint={`4 dígitos, começando com ${operacao.direcao === 'entrada' ? '2' : '6'}.`}
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.cfopInterestadual}
                  inputMode="numeric"
                  maxLength={4}
                  disabled={!podeGravar}
                  onChange={(e) => set('cfopInterestadual')(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Grupo tributário da devolução"
              hint="Em branco: a devolução usa o grupo do próprio produto."
            >
              {(p) => (
                <select
                  {...p}
                  value={form.grupoTributario}
                  disabled={!podeGravar}
                  onChange={(e) => set('grupoTributario')(e.target.value)}
                  className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                    bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
                >
                  <option value="">Usar o grupo do produto</option>
                  {grupos.map((g) => (
                    <option key={g.id} value={g.code}>
                      {g.code} — {g.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        ) : (
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            O CFOP e a tributação da VENDA moram no grupo tributário de cada produto (
            <Link
              to="/sistema/produtos/auxiliares?aba=tributarios"
              className="font-semibold text-[var(--gs-purple-800)] underline"
            >
              Catálogo › Grupos tributários
            </Link>
            ): eles variam por mercadoria, e uma segunda cópia aqui divergiria dela.
          </p>
        )}

        <Field label="Observação" hint="Fica na trilha de auditoria — o que o contador disse, e quando.">
          {(p) => (
            <Input
              {...p}
              value={form.observacao}
              maxLength={500}
              disabled={!podeGravar}
              onChange={(e) => set('observacao')(e.target.value)}
            />
          )}
        </Field>

        <label className="flex items-start gap-2 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          <input
            type="checkbox"
            checked={form.confirmada}
            disabled={!podeGravar}
            onChange={(e) => set('confirmada')(e.target.checked)}
            className="mt-1"
          />
          <span>
            O contador conferiu e confirmou esta operação (natureza, CFOP e tributação).
            {devolucao && ' Em produção, a devolução só sai com esta confirmação.'}
          </span>
        </label>

        {erroLocal && (
          <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {erroLocal}
          </p>
        )}

        {podeGravar ? (
          <div>
            <Button loading={busy} disabled={prazoInvalido} onClick={() => void salvar()}>
              Salvar {operacao.rotulo.toLowerCase()}
            </Button>
          </div>
        ) : (
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Gravar estes parâmetros é do dono do grupo — o mesmo alcance da política de
            contingência. A gerência da operação lê, confere com o contador e pede a gravação.
          </p>
        )}
      </div>
    </Card>
  );
}
