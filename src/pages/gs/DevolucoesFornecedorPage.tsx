/**
 * Compras › Devoluções ao fornecedor (GAP-PRD-089).
 *
 * O QUE ESTA TELA FAZ que nenhuma outra fazia: devolver PARTE de uma compra que
 * continua valendo. O estorno (em Entrada de notas) desfaz a nota inteira e só
 * enquanto nada foi pago nem vendido; aqui a pastilha com defeito de uma compra
 * paga e metade vendida volta ao fornecedor com documento, crédito e rastro.
 *
 * Três pedaços na mesma tela, e o endereço diz qual está aberto:
 *
 *   ?nota=<id>              a devolução NOVA contra aquela nota (o botão
 *                           "Devolver" da Entrada de notas traz até aqui);
 *   ?devolucao-compra=<id>  a ficha de uma devolução — é para cá que o título
 *                           de crédito no financeiro navega;
 *   (nada)                  a lista, com a pendência fiscal de cada uma.
 *
 * Registrar e resolver o fiscal é da GERÊNCIA (o recorte das rotas): mexe em
 * estoque E em dívida, como o estorno. O estoquista lê.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { useHasProfile } from '@/hooks/useSession';
import { useCan } from '@/hooks/useCan';
import { ApiRequestError } from '@/lib/api/client';
import { dataBR } from '@/lib/datas';
import {
  PARAM_DA_DEVOLUCAO_DE_COMPRA,
  PARAM_DA_NOTA,
  rotaDaNotaDeEntrada,
} from '@/lib/rotasDeOrigem';
import {
  devolucoesFornecedorApi,
  type DevolucaoDetalhe,
  type DevolucaoResumo,
  type Devolviveis,
  type ModoFinanceiro,
  type SituacaoFiscal,
} from '@/lib/api/devolucoesFornecedor';

const ROTULO_FISCAL: Record<SituacaoFiscal, string> = {
  pendente: 'NF-e de devolução pendente',
  emitida: 'NF-e de devolução emitida',
  nota_do_fornecedor: 'Fornecedor emite a nota de entrada',
  dispensada: 'Sem documento fiscal (dispensada)',
};

const TOM_FISCAL: Record<SituacaoFiscal, 'warning' | 'success' | 'info' | 'neutral'> = {
  pendente: 'warning',
  emitida: 'success',
  nota_do_fornecedor: 'info',
  dispensada: 'neutral',
};

const ROTULO_FINANCEIRO: Record<ModoFinanceiro, string> = {
  abatimento: 'Abatido da dívida da nota',
  credito: 'Crédito a receber do fornecedor',
  sem_financeiro: 'Sem efeito financeiro',
};

function mensagemDe(err: unknown, padrao: string): string {
  return err instanceof ApiRequestError ? err.message : padrao;
}

/** Reais digitados ("27,50") para centavos; vazio = nulo. */
function reaisParaCentavos(texto: string): number | null {
  const limpo = texto.trim().replace(/\./g, '').replace(',', '.');
  if (!limpo) return null;
  const n = Number(limpo);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// ------------------------------------------------------------ a devolução nova

function NovaDevolucao({
  noteId,
  aoRegistrar,
  aoCancelar,
}: {
  noteId: string;
  aoRegistrar: (d: DevolucaoDetalhe) => void;
  aoCancelar: () => void;
}) {
  const [dados, setDados] = useState<Devolviveis | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [quantidades, setQuantidades] = useState<Record<string, string>>({});
  const [unidades, setUnidades] = useState<Record<string, string[]>>({});
  const [motivo, setMotivo] = useState('');
  const [modo, setModo] = useState<ModoFinanceiro | null>(null);
  const [credito, setCredito] = useState('');
  const [vencimento, setVencimento] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let vivo = true;
    setDados(null);
    setErro(null);
    devolucoesFornecedorApi
      .devolviveis(noteId)
      .then((d) => {
        if (!vivo) return;
        setDados(d);
        // O modo SUGERIDO: se a nota ainda deve, abate; se já pagou, crédito;
        // sem dívida nenhuma, sem efeito. Quem devolve pode trocar.
        setModo(d.saldoEmAbertoCents > 0 ? 'abatimento' : d.temTitulo ? 'credito' : 'sem_financeiro');
      })
      .catch((err) => vivo && setErro(mensagemDe(err, 'Falha ao ler o que esta nota pode devolver.')));
    return () => {
      vivo = false;
    };
  }, [noteId]);

  const linhas = useMemo(
    () =>
      (dados?.itens ?? [])
        .map((i) => ({ item: i, quantidade: Number((quantidades[i.productId] ?? '').replace(',', '.')) || 0 }))
        .filter((l) => l.quantidade > 0),
    [dados, quantidades],
  );
  const mercadorias = linhas.reduce((s, l) => s + Math.round(l.quantidade * l.item.unitCostCents), 0);

  async function registrar() {
    if (!dados || !modo) return;
    setSalvando(true);
    setErro(null);
    try {
      const creditCents = reaisParaCentavos(credito);
      const d = await devolucoesFornecedorApi.registrar({
        noteId,
        reason: motivo.trim(),
        financeMode: modo,
        items: linhas.map((l) => ({
          productId: l.item.productId,
          quantity: l.quantidade,
          ...(l.item.serializado ? { unitIds: unidades[l.item.productId] ?? [] } : {}),
        })),
        ...(creditCents !== null && modo !== 'sem_financeiro' ? { creditCents } : {}),
        ...(modo === 'credito' && vencimento ? { dueDate: vencimento } : {}),
      });
      aoRegistrar(d);
    } catch (err) {
      setErro(mensagemDe(err, 'Falha ao registrar a devolução.'));
    } finally {
      setSalvando(false);
    }
  }

  if (erro && !dados) {
    return (
      <Card title="Nova devolução">
        <p role="alert" className="m-0 text-[var(--gs-danger)]">{erro}</p>
        <Button variant="ghost" className="mt-3" onClick={aoCancelar}>Voltar à lista</Button>
      </Card>
    );
  }
  if (!dados) {
    return (
      <Card title="Nova devolução">
        <p role="status" className="m-0 text-[var(--gs-muted)]">Lendo a nota…</p>
      </Card>
    );
  }

  return (
    <Card
      title={`Nova devolução — ${dados.nota.rotulo}`}
      subtitle={`${dados.nota.supplierName ?? 'Fornecedor não identificado'} · total da nota ${formatCents(dados.nota.totalCents)}`}
    >
      {dados.nota.status !== 'recebida' && (
        <p role="alert" className="mt-0 text-[var(--gs-danger)]">
          Esta nota não está recebida: não há mercadoria dela no estoque para devolver.
        </p>
      )}
      {erro && (
        <p role="alert" className="mt-0 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">{erro}</p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
          <thead>
            <tr className="text-left text-[var(--gs-muted)]">
              <th className="py-2">Produto</th>
              <th className="py-2 text-right">Entrou</th>
              <th className="py-2 text-right">Já voltou</th>
              <th className="py-2 text-right">Livre hoje</th>
              <th className="py-2 text-right">Custo unit.</th>
              <th className="py-2 w-32">Devolver</th>
            </tr>
          </thead>
          <tbody>
            {dados.itens.map((i) => (
              <tr key={i.productId} className="border-t border-[var(--gs-border)] align-top">
                <td className="py-2">
                  {i.name}
                  {i.internalCode && (
                    <span className="ml-2 font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                      {i.internalCode}
                    </span>
                  )}
                  {i.serializado && i.unidades.length > 0 && (
                    <fieldset className="mt-1 border-0 p-0">
                      <legend className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        Controlado por unidade: marque QUAIS peças voltam
                      </legend>
                      {i.unidades.map((u) => (
                        <label key={u.id} className="flex items-center gap-2 text-[length:var(--gs-text-xs)]">
                          <input
                            type="checkbox"
                            checked={(unidades[i.productId] ?? []).includes(u.id)}
                            onChange={(e) => {
                              const atual = unidades[i.productId] ?? [];
                              const novo = e.target.checked ? [...atual, u.id] : atual.filter((x) => x !== u.id);
                              setUnidades((m) => ({ ...m, [i.productId]: novo }));
                              setQuantidades((m) => ({ ...m, [i.productId]: String(novo.length) }));
                            }}
                          />
                          {u.identificacao}
                        </label>
                      ))}
                    </fieldset>
                  )}
                </td>
                <td className="py-2 text-right">{formatQuantity(i.entrou)}</td>
                <td className="py-2 text-right">{formatQuantity(i.jaDevolvido)}</td>
                <td className="py-2 text-right">{formatQuantity(i.disponivel)}</td>
                <td className="py-2 text-right">{formatCents(i.unitCostCents)}</td>
                <td className="py-2">
                  <Input
                    type="number"
                    min={0}
                    max={i.podeDevolver}
                    step="any"
                    aria-label={`Quantidade de ${i.name} a devolver`}
                    disabled={i.podeDevolver <= 0 || i.serializado}
                    value={quantidades[i.productId] ?? ''}
                    onChange={(e) => setQuantidades((m) => ({ ...m, [i.productId]: e.target.value }))}
                    placeholder={i.podeDevolver > 0 ? `até ${formatQuantity(i.podeDevolver)}` : 'nada a devolver'}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <Field label="Motivo da devolução" required>
          {(p) => (
            <Input
              {...p}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Duas pastilhas com defeito de fábrica"
            />
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            O que acontece com o dinheiro
          </span>
          {(['abatimento', 'credito', 'sem_financeiro'] as ModoFinanceiro[]).map((m) => (
            <label key={m} className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
              <input type="radio" name="modo-financeiro" checked={modo === m} onChange={() => setModo(m)} />
              {ROTULO_FINANCEIRO[m]}
              {m === 'abatimento' && ` (a nota ainda deve ${formatCents(dados.saldoEmAbertoCents)})`}
              {m === 'sem_financeiro' && ' — só para nota sem dívida (bonificação)'}
            </label>
          ))}
        </div>
        {modo !== 'sem_financeiro' && (
          <Field
            label="Valor combinado com o fornecedor (R$)"
            hint={`Em branco = o valor das mercadorias pelo custo de entrada (${formatCents(mercadorias)}). Informe outro se ele devolve também IPI ou frete.`}
          >
            {(p) => (
              <Input {...p} value={credito} onChange={(e) => setCredito(e.target.value)} inputMode="decimal" />
            )}
          </Field>
        )}
        {modo === 'credito' && (
          <Field label="Vencimento do crédito" hint="Em branco = daqui a 30 dias.">
            {(p) => <Input {...p} type="date" value={vencimento} onChange={(e) => setVencimento(e.target.value)} />}
          </Field>
        )}
      </div>

      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        A mercadoria sai do estoque como “Devolução ao fornecedor”, com o custo com que entrou. A NF-e
        de devolução fica como pendência nesta tela até alguém registrar a chave da nota emitida.
      </p>

      <div className="flex flex-wrap gap-2 mt-2">
        <Button
          loading={salvando}
          disabled={linhas.length === 0 || motivo.trim().length < 3 || !modo || dados.nota.status !== 'recebida'}
          onClick={() => void registrar()}
        >
          Registrar devolução ({formatCents(mercadorias)})
        </Button>
        <Button variant="ghost" onClick={aoCancelar}>Cancelar</Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------ a ficha

function FichaDaDevolucao({
  devolucao,
  gerencia,
  podeEmitirNfe,
  aoMudar,
  aoFechar,
}: {
  devolucao: DevolucaoDetalhe;
  /** O que as rotas de `requireProfile` cobram: registrar a situação fiscal à mão. */
  gerencia: boolean;
  /**
   * O que a rota da EMISSÃO cobra: `fiscal.manage` — a capability, e não o
   * código do perfil.
   *
   * O DEFEITO: o botão novo saía sob `useHasProfile('gerente_loja',
   * 'gerente_oficina')`, reaproveitado do resto da ficha, enquanto
   * `POST /core/fiscal/devolucoes/compra/:returnId/nfe` cobra `fiscal.manage`.
   * Com acesso personalizado em Usuários › Acesso os dois lados divergem: quem
   * tem a capability sem o perfil não vê o gesto — o mesmo beco sem saída que
   * esta frente veio fechar — e o gerente a quem tiraram `fiscal.manage` vê o
   * botão e leva 403. A pergunta certa é a que o servidor faz.
   */
  podeEmitirNfe: boolean;
  aoMudar: (d: DevolucaoDetalhe) => void;
  aoFechar: () => void;
}) {
  const [status, setStatus] = useState<Exclude<SituacaoFiscal, 'pendente'>>('emitida');
  const [chave, setChave] = useState('');
  const [nota, setNota] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [emitindo, setEmitindo] = useState(false);
  const [emissao, setEmissao] = useState<string | null>(null);
  const [pendenciasDoContador, setPendenciasDoContador] = useState<string[]>([]);

  /*
    EMITIR A NF-e DE DEVOLUÇÃO AQUI (P0 fiscal).

    A ficha só sabia REGISTRAR a chave de uma nota emitida em outro lugar — a
    rota de emissão existia e nenhuma tela a chamava, então a devolução ao
    fornecedor terminava sempre no emissor do contador. O corpo vai vazio: o
    destinatário é o fornecedor da nota de entrada, e o servidor o lê do
    cadastro. Cadastro incompleto vira recusa que NOMEIA o campo que falta.

    A situação fiscal da devolução vira "emitida" sozinha quando a SEFAZ
    autoriza (aoAutorizarNotaDeDevolucao) — por isso a ficha é relida depois.
  */
  async function emitirNfe() {
    setEmitindo(true);
    setErro(null);
    setEmissao(null);
    try {
      const r = await devolucoesFornecedorApi.emitirNfe(devolucao.id);
      setEmissao(
        `NF-e ${r.document.number}, série ${r.document.serie}: ${r.statusLabel ?? r.document.status}.`
        + (r.document.accessKey ? ` Chave ${r.document.accessKey}.` : ''),
      );
      setPendenciasDoContador(r.pendencias ?? []);
      aoMudar(await devolucoesFornecedorApi.abrir(devolucao.id));
    } catch (err) {
      setErro(mensagemDe(err, 'Falha ao emitir a NF-e de devolução.'));
    } finally {
      setEmitindo(false);
    }
  }

  async function registrarFiscal() {
    setSalvando(true);
    setErro(null);
    try {
      aoMudar(
        await devolucoesFornecedorApi.registrarFiscal(devolucao.id, {
          status,
          ...(chave.trim() ? { accessKey: chave.trim() } : {}),
          ...(nota.trim() ? { note: nota.trim() } : {}),
        }),
      );
      setChave('');
      setNota('');
    } catch (err) {
      setErro(mensagemDe(err, 'Falha ao registrar a situação fiscal.'));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card title={`Devolução #${devolucao.number} · ${devolucao.supplierName ?? ''}`}>
      <div className="flex flex-wrap items-center gap-3 mb-3 text-[length:var(--gs-text-sm)]">
        <Badge tone={TOM_FISCAL[devolucao.fiscalStatus]}>{ROTULO_FISCAL[devolucao.fiscalStatus]}</Badge>
        <span>
          Nota de origem:{' '}
          <Link to={rotaDaNotaDeEntrada(devolucao.noteId)} className="text-[var(--gs-purple-700)] underline">
            {devolucao.noteLabel}
          </Link>
        </span>
        <span>
          em {dataBR(devolucao.createdAt)}
          {devolucao.createdByName ? ` por ${devolucao.createdByName}` : ''}
        </span>
      </div>
      <p className="mt-0 text-[length:var(--gs-text-sm)]">Motivo: {devolucao.reason}</p>

      <div className="overflow-x-auto">
        <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
          <thead>
            <tr className="text-left text-[var(--gs-muted)]">
              <th className="py-2">Produto</th>
              <th className="py-2 text-right">Quantidade</th>
              <th className="py-2 text-right">Custo unit.</th>
              <th className="py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {devolucao.items.map((i) => (
              <tr key={i.productId} className="border-t border-[var(--gs-border)]">
                <td className="py-2">{i.name}</td>
                <td className="py-2 text-right">{formatQuantity(i.quantity)}</td>
                <td className="py-2 text-right">{formatCents(i.unitCostCents)}</td>
                <td className="py-2 text-right">{formatCents(i.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="text-[length:var(--gs-text-base)] mb-1">Financeiro</h3>
      <p className="mt-0 text-[length:var(--gs-text-sm)]">
        {ROTULO_FINANCEIRO[devolucao.financeMode]}: {formatCents(devolucao.creditCents)}
        {devolucao.creditCents !== devolucao.goodsCents &&
          ` (mercadorias pelo custo de entrada: ${formatCents(devolucao.goodsCents)})`}
      </p>
      {devolucao.financeDetail.length > 0 && (
        <ul className="mt-0 text-[length:var(--gs-text-sm)]">
          {devolucao.financeDetail.map((d) => (
            <li key={d.entryId}>
              Título da nota: {formatCents(d.antesCents)} → {formatCents(d.depoisCents)}
              {d.cancelado ? ' (tudo o que se devia voltou: título cancelado)' : ''}
            </li>
          ))}
        </ul>
      )}

      <h3 className="text-[length:var(--gs-text-base)] mb-1">Documento fiscal</h3>
      {devolucao.pendenciaFiscal ? (
        <p role="status" className="mt-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
          {devolucao.pendenciaFiscal}
        </p>
      ) : (
        <p className="mt-0 text-[length:var(--gs-text-sm)]">
          {ROTULO_FISCAL[devolucao.fiscalStatus]}
          {devolucao.fiscalAccessKey ? ` — chave ${devolucao.fiscalAccessKey}` : ''}
          {devolucao.fiscalNote ? ` — ${devolucao.fiscalNote}` : ''}
        </p>
      )}

      {podeEmitirNfe && devolucao.fiscalStatus === 'pendente' && (
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <Button loading={emitindo} onClick={() => void emitirNfe()}>
              Emitir NF-e de devolução
            </Button>
          </div>
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            A nota sai pelo DEVORA, com o destinatário lido do cadastro do fornecedor e a nota de
            entrada referenciada. Se o fornecedor for quem emite a nota, use o registro abaixo.
          </p>
        </div>
      )}

      {/*
        O RESULTADO DA EMISSÃO FICA FORA DO BLOCO DA PENDÊNCIA.

        Dentro dele, a confirmação sumia no instante em que a emissão dava
        certo: a ficha é relida, a situação vira "emitida", o bloco inteiro
        (que só existe enquanto está "pendente") desaparece — e com ele a frase
        que dizia o número da nota e a pendência do contador. Quem clicou não
        via nada acontecer.
      */}
      {emissao && (
        <p role="status" className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
          {emissao}
        </p>
      )}
      {pendenciasDoContador.map((p) => (
        <p key={p} className="mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
          {p}
        </p>
      ))}

      {gerencia && devolucao.fiscalStatus === 'pendente' && (
        <div className="grid gap-3 md:grid-cols-3 items-end mt-2">
          <Field label="Situação">
            {(p) => (
              <select
                {...p}
                value={status}
                onChange={(e) => setStatus(e.target.value as Exclude<SituacaoFiscal, 'pendente'>)}
                className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-[var(--gs-surface)] px-3 py-2"
              >
                <option value="emitida">NF-e de devolução emitida</option>
                <option value="nota_do_fornecedor">Fornecedor emite a nota de entrada</option>
                <option value="dispensada">Sem documento fiscal</option>
              </select>
            )}
          </Field>
          {status !== 'dispensada' ? (
            <Field label={status === 'emitida' ? 'Chave da NF-e de devolução' : 'Chave (se já tiver)'}>
              {(p) => (
                <Input {...p} value={chave} onChange={(e) => setChave(e.target.value)} placeholder="44 dígitos" />
              )}
            </Field>
          ) : (
            <Field label="Por que fica sem documento">
              {(p) => <Input {...p} value={nota} onChange={(e) => setNota(e.target.value)} />}
            </Field>
          )}
          <Button loading={salvando} onClick={() => void registrarFiscal()}>
            Registrar situação fiscal
          </Button>
        </div>
      )}
      {erro && <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">{erro}</p>}

      <div className="mt-4">
        <Button variant="ghost" onClick={aoFechar}>Fechar</Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------ a tela

export default function DevolucoesFornecedorPage() {
  const [params, setParams] = useSearchParams();
  const notaPedida = params.get(PARAM_DA_NOTA);
  const devolucaoPedida = params.get(PARAM_DA_DEVOLUCAO_DE_COMPRA);
  const gerencia = useHasProfile('gerente_loja', 'gerente_oficina');
  // A emissão pergunta pela CAPABILITY, que é o que a rota cobra; o registro à
  // mão e a nova devolução continuam sob as rotas de perfil.
  const podeEmitirNfe = useCan('fiscal.manage');

  const [lista, setLista] = useState<DevolucaoResumo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [aberta, setAberta] = useState<DevolucaoDetalhe | null>(null);

  const carregar = useCallback(async () => {
    try {
      setLista(await devolucoesFornecedorApi.listar());
      setErro(null);
    } catch (err) {
      setLista(null);
      setErro(mensagemDe(err, 'Falha ao carregar as devoluções.'));
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => {
    if (!devolucaoPedida) {
      setAberta(null);
      return;
    }
    let vivo = true;
    devolucoesFornecedorApi
      .abrir(devolucaoPedida)
      .then((d) => vivo && setAberta(d))
      .catch((err) => vivo && setErro(mensagemDe(err, 'Falha ao abrir a devolução.')));
    return () => {
      vivo = false;
    };
  }, [devolucaoPedida]);

  const pendentes = (lista ?? []).filter((d) => d.fiscalStatus === 'pendente').length;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Compras', 'Devoluções ao fornecedor']}
        title="Devoluções ao fornecedor"
        subtitle="Parte de uma compra que volta para quem vendeu — com estoque, crédito e documento"
      />

      {erro && <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">{erro}</p>}
      {aviso && <p role="status" className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {notaPedida && gerencia && (
        <NovaDevolucao
          noteId={notaPedida}
          aoCancelar={() => setParams({}, { replace: true })}
          aoRegistrar={(d) => {
            setAviso(
              `Devolução #${d.number} registrada: a mercadoria saiu do estoque e ${
                d.financeMode === 'abatimento'
                  ? 'a dívida da nota diminuiu'
                  : d.financeMode === 'credito'
                    ? 'o crédito a receber do fornecedor foi lançado'
                    : 'nada mudou no financeiro'
              }. Falta a NF-e de devolução.`,
            );
            setParams({ [PARAM_DA_DEVOLUCAO_DE_COMPRA]: d.id }, { replace: true });
            void carregar();
          }}
        />
      )}
      {notaPedida && !gerencia && (
        <Card title="Nova devolução">
          <p className="m-0 text-[length:var(--gs-text-sm)]">
            Registrar devolução mexe no estoque e na dívida com o fornecedor: é decisão da gerência.
          </p>
        </Card>
      )}

      {aberta && (
        <FichaDaDevolucao
          devolucao={aberta}
          gerencia={gerencia}
          podeEmitirNfe={podeEmitirNfe}
          aoMudar={(d) => {
            setAberta(d);
            void carregar();
          }}
          aoFechar={() => setParams({}, { replace: true })}
        />
      )}

      <Card
        title="Devoluções registradas"
        subtitle={
          pendentes > 0
            ? `${pendentes} com NF-e de devolução pendente.`
            : 'Para devolver, abra a nota em Entrada de notas e use "Devolver".'
        }
      >
        {lista === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {erro ? 'Lista indisponível.' : 'Carregando…'}
          </p>
        ) : lista.length === 0 ? (
          <EmptyState
            title="Nenhuma devolução ao fornecedor"
            description="Devolva mercadoria a partir da nota de entrada: Compras › Entrada de notas › Devolver."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Nº</th>
                  <th className="py-2">Nota</th>
                  <th className="py-2">Fornecedor</th>
                  <th className="py-2">Financeiro</th>
                  <th className="py-2 text-right">Valor</th>
                  <th className="py-2">Fiscal</th>
                  <th className="py-2">Data</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {lista.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2 font-mono">#{d.number}</td>
                    <td className="py-2">{d.noteLabel}</td>
                    <td className="py-2">{d.supplierName ?? '—'}</td>
                    <td className="py-2">{ROTULO_FINANCEIRO[d.financeMode]}</td>
                    <td className="py-2 text-right">{formatCents(d.creditCents || d.goodsCents)}</td>
                    <td className="py-2">
                      <Badge tone={TOM_FISCAL[d.fiscalStatus]}>{ROTULO_FISCAL[d.fiscalStatus]}</Badge>
                    </td>
                    <td className="py-2">{dataBR(d.createdAt)}</td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setParams({ [PARAM_DA_DEVOLUCAO_DE_COMPRA]: d.id }, { replace: true })}
                      >
                        Abrir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
