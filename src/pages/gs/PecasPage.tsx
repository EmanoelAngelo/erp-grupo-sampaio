/**
 * Oficina › Peças.
 *
 * A tela da bancada: o que tem na gaveta, onde está, o que está acabando — e,
 * desde a rodada 55, como a peça ENTRA.
 *
 * ## O QUE ELA NÃO CONSEGUIA FAZER
 *
 * Tinha 193 linhas e nenhum POST. Listava e procurava, e era só. Cadastrar,
 * repor, dizer o mínimo e dizer em que prateleira a peça mora eram todos atos
 * do cadastro de PRODUTO — que é tela de gestão e fica fechada para o
 * mecânico, a pessoa que está com a peça na mão. Na prática ninguém preenchia
 * o mínimo, e o aviso de "está acabando" nunca disparava para a peça nascida
 * de nota, porque ela nasce com mínimo zero.
 *
 * ## BIPAR E RESOLVER
 *
 * Um código, duas saídas: existe e se repõe, não existe e se cadastra com o
 * código já preenchido. É o gesto do sistema anterior, e ele é bom porque
 * descreve o que a pessoa está fazendo de verdade — a peça chegou e está na
 * mão dela.
 *
 * Quem SÓ LÊ (o mecânico) bipa para consultar: quanto tem, onde está, qual o
 * mínimo. É o uso mais frequente do leitor na bancada, e é por isso que o
 * resultado da bipagem aparece para ele também.
 *
 * O MECÂNICO NÃO VÊ CUSTO, e a coluna simplesmente não existe para ele — o
 * servidor remove o campo da resposta, não a tela o esconde. Se `cost_cents`
 * vier ausente, é porque quem está olhando não deve ver.
 *
 * ## O ESTADO VAZIO TEM DOIS LEITORES
 *
 * Quem CONSEGUE dar entrada lê o caminho daqui mesmo; quem não consegue lê o
 * que é verdade do lado dele — a peça chega pela nota do fornecedor e quem a
 * marca é quem cuida do catálogo. Um texto único mandaria a pessoa mais
 * provável a uma porta que não abre para ela.
 */
import { useCallback, useEffect, useState } from 'react';
import { uuid } from '@/lib/uuid';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SearchInput,
} from '@/components/gs/ui';
import { formatCents, parseQuantity, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type ResultadoDoScan, type WorkshopPart, type Workshop } from '@/lib/api/core';
import { useHasProfile } from '@/hooks/useSession';
import { TentativaJaRegistrada } from '@/components/gs/TentativaJaRegistrada';
import { ehTentativaJaRegistrada } from '@/lib/api/tentativaJaRegistrada';

/** Estado do formulário de entrada — um só, para as duas portas. */
interface FormularioDeEntrada {
  nome: string;
  codigo: string;
  custo: string;
  markup: string;
  preco: string;
  quantidade: string;
  minimo: string;
  local: string;
  nfNumero: string;
  nfFornecedor: string;
  nfValor: string;
}

const VAZIO: FormularioDeEntrada = {
  nome: '',
  codigo: '',
  custo: '',
  // O padrão do sistema anterior. É um ponto de partida visível no campo, e
  // não um número que o servidor aplica calado.
  markup: '40',
  preco: '',
  quantidade: '1',
  minimo: '3',
  local: '',
  nfNumero: '',
  nfFornecedor: '',
  nfValor: '',
};

/**
 * A chave de UM gesto de entrada.
 *
 * Nasce quando o formulário nasce — no bipe — e vive até o formulário
 * fechar. Dois bipes da mesma nota (o fornecedor entregou em duas viagens)
 * dão duas chaves e somam duas vezes, que é o certo; dois cliques no mesmo
 * formulário mandam a MESMA chave e somam uma vez só, que também é o certo.
 */
function novaChaveDeEntrada(): string {
  return `bancada-${uuid()}`;
}

export default function PecasPage() {
  const [pecas, setPecas] = useState<WorkshopPart[] | null>(null);
  /** O que está acabando na GAVETA — independente do que a busca filtrou. */
  const [faltando, setFaltando] = useState<WorkshopPart[]>([]);
  const [falhou, setFalhou] = useState(false);
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [bancadas, setBancadas] = useState<Workshop[]>([]);
  const [bancadaId, setBancadaId] = useState('');

  const [codigoBipado, setCodigoBipado] = useState('');
  const [scan, setScan] = useState<ResultadoDoScan | null>(null);
  const [chaveDaEntrada, setChaveDaEntrada] = useState(novaChaveDeEntrada);
  const [form, setForm] = useState<FormularioDeEntrada>(VAZIO);
  const [ocupado, setOcupado] = useState(false);
  /**
   * O servidor recusou a chave do gesto por ela já ter registrado OUTRA entrada
   * (422, R2-IDEM): guarda como repetir o gesto com chave nova, se a pessoa quiser.
   */
  const [tentativaReusada, setTentativaReusada] = useState<{ repetir: () => void } | null>(null);

  /** A peça sendo ajustada (mínimo e endereço), e os dois campos dela. */
  const [ajustando, setAjustando] = useState<WorkshopPart | null>(null);
  const [ajusteMinimo, setAjusteMinimo] = useState('');
  const [ajusteLocal, setAjusteLocal] = useState('');

  function abrirAjuste(peca: WorkshopPart) {
    setAjustando(peca);
    // Os valores ATUAIS, não em branco: abrir vazio faria "salvar sem mexer"
    // apagar o que já estava lá.
    setAjusteMinimo(peca.min_stock > 0 ? String(peca.min_stock) : '');
    setAjusteLocal(peca.storage_location ?? '');
  }

  /*
    Os MESMOS perfis que as rotas de entrada aceitam. Não é "quem é da gestão":
    o atendente é da gestão, alcança esta tela e mesmo assim levaria 403 ao
    cadastrar. Quem lê "cadastre por aqui" tem de ser quem consegue.
  */
  const daEntrada = useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      /*
        DUAS LEITURAS, PORQUE SÃO DUAS PERGUNTAS.

        A tabela responde "o que eu procurei". O aviso responde "o que está
        acabando NA GAVETA" — e essa resposta não pode depender do que a pessoa
        digitou na busca. Derivar o aviso da lista filtrada fazia procurar
        "bateria" esconder que o parafuso acabou: o alerta sumia sem nada ter
        mudado no estoque, que é a forma mais silenciosa de um alerta falhar.

        A segunda leitura só acontece quando há busca ativa; sem filtro as duas
        perguntas têm a mesma resposta.
      */
      const [filtradas, gavetaInteira] = await Promise.all([
        coreApi.listParts({ search: busca }),
        busca.trim() ? coreApi.listParts({}) : Promise.resolve(null),
      ]);
      setPecas(filtradas);
      setFaltando((gavetaInteira ?? filtradas).filter((p) => p.below_minimum));
    } catch (err) {
      setPecas(null);
      setFaltando([]);
      // `pecas === null` é o estado de CARREGANDO. Deixá-lo assim depois de uma
      // falha faria a tela girar para sempre ao lado da mensagem de erro.
      setFalhou(true);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar as peças.');
    }
  }, [busca]);

  useEffect(() => {
    setFalhou(false);
    void carregar();
  }, [carregar]);

  useEffect(() => {
    if (!daEntrada) return;
    void coreApi
      .listWorkshops()
      .then((lista) => {
        const comPeca = lista.filter((w) => w.capabilities?.parts);
        setBancadas(comPeca);
        // Com UMA bancada só não há o que escolher, e um select de uma opção
        // é uma pergunta cuja resposta a tela já sabe.
        if (comPeca.length === 1) setBancadaId(comPeca[0].id);
      })
      .catch(() => setBancadas([]));
  }, [daEntrada]);

  // Ausência do campo é a informação: o servidor removeu porque quem olha não
  // pode ver.
  const mostraCusto = (pecas ?? []).some((p) => p.cost_cents !== undefined);

  /** O preço que vai valer, calculado na tela só para MOSTRAR antes de gravar. */
  const custoCents = parseReaisToCents(form.custo) ?? 0;
  const markupNum = form.markup.trim() ? Number(form.markup.replace(',', '.')) : null;
  const precoDerivado =
    markupNum != null && Number.isFinite(markupNum) && markupNum >= 0
      ? Math.round(custoCents * (1 + markupNum / 100))
      : null;

  function campo(nome: keyof FormularioDeEntrada, valor: string) {
    setForm((atual) => ({ ...atual, [nome]: valor }));
  }

  async function executar(acao: (chave: string) => Promise<string>, chave: string = chaveDaEntrada) {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      setAviso(await acao(chave));
      await carregar();
    } catch (err) {
      if (ehTentativaJaRegistrada(err)) {
        // A chave do gesto já registrou OUTRA entrada: reenviar é 422 para
        // sempre. Registrar de novo — com chave nova — é escolha da pessoa.
        setTentativaReusada({
          repetir: () => {
            const nova = novaChaveDeEntrada();
            setChaveDaEntrada(nova);
            setTentativaReusada(null);
            void executar(acao, nova);
          },
        });
        return;
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Não deu para concluir.');
    } finally {
      setOcupado(false);
    }
  }

  /**
   * O bipe resolve — e limpa atrás de si.
   *
   * As duas portas partem do MESMO estado de formulário, e cada uma quer um
   * ponto de partida diferente:
   *
   *   CADASTRO: percentual sugerido (40%, como no sistema anterior), porque
   *   sem percentual e sem preço a peça nasce imprestável — `addPart` recusa
   *   peça de preço zero.
   *
   *   REPOSIÇÃO: percentual VAZIO, porque preencher significa REPREÇAR. Um 40
   *   de fábrica faria toda reposição mexer no preço de venda sem ninguém
   *   pedir — e preço que muda sozinho é preço que ninguém decidiu, aparecendo
   *   na conta do cliente sem a loja saber que aumentou. Custo em branco pela
   *   mesma razão: em branco, mantém o que está.
   *
   * E o CÓDIGO sai do campo depois de lido: o leitor USB digita no fim do que
   * já está lá, então o segundo bipe concatenaria no primeiro e procuraria um
   * código de 26 dígitos que não existe em lugar nenhum.
   */
  async function bipar() {
    const codigo = codigoBipado.trim();
    if (!codigo) return;
    setErro(null);
    setAviso(null);
    try {
      const resultado = await coreApi.scanPeca(codigo);
      setScan(resultado);
      /*
        A CHAVE NASCE COM O FORMULÁRIO, e não com o clique.

        É o que separa os dois casos que se parecem no servidor: duas
        cargas da mesma nota são dois bipes e ganham duas chaves; o clique
        repetido no botão "Repor" é o MESMO formulário e reenvia a mesma —
        então o razão soma uma vez só.
      */
      setChaveDaEntrada(novaChaveDeEntrada());
      setCodigoBipado('');
      setForm(
        resultado.encontrada
          ? { ...VAZIO, codigo, markup: '', custo: '', quantidade: '1' }
          // O cadastro nasce com o código já preenchido: é o que impede a
          // pessoa de digitá-lo de novo — e errado.
          : { ...VAZIO, codigo },
      );
    } catch (err) {
      setScan(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao ler o código.');
    }
  }

  function documento() {
    return {
      numero: form.nfNumero,
      fornecedor: form.nfFornecedor || null,
      valorTotalCents: parseReaisToCents(form.nfValor),
    };
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Oficina', 'Peças']}
        title="Peças"
        subtitle="O estoque da bancada. Peça pertence a uma oficina — a de celulares não enxerga a de mobilidade."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {tentativaReusada && (
        <TentativaJaRegistrada
          titulo="Esta tentativa já registrou uma entrada"
          onVoltar={() => setTentativaReusada(null)}
          rotuloDoNovo="Registrar como entrada nova"
          onNovo={tentativaReusada.repetir}
          ocupado={ocupado}
          testId="entrada-de-peca-ja-registrada"
        >
          <p className="m-0">
            <strong>Esta tentativa já registrou outra entrada de peça, com outra quantidade ou outro custo.</strong>{' '}
            Nada foi lançado agora.
          </p>
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Acontece quando a resposta do primeiro envio se perde e o formulário muda antes de tentar de novo. Se
            chegaram mesmo mais peças, registre como entrada nova. Se era a mesma entrada corrigida, confira a gaveta
            antes: registrar de novo somaria as peças duas vezes.
          </p>
        </TentativaJaRegistrada>
      )}
      {aviso && (
        <p role="status" className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">
          {aviso}
        </p>
      )}

      {faltando.length > 0 && (
        <Card title="Abaixo do mínimo">
          <p className="m-0 text-[length:var(--gs-text-sm)]">
            {faltando.length} peça(s) abaixo do mínimo:{' '}
            <strong>{faltando.map((p) => p.name).join(', ')}</strong>. Peça que acaba no meio de um
            conserto para o serviço.
          </p>
        </Card>
      )}

      {daEntrada && (
        <Card
          title="Bipar peça"
          subtitle="Se já existe, repõe. Se não existe, cadastra com o código preenchido."
          className="mb-5"
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Código de barras ou interno">
              {(p) => (
                <Input
                  {...p}
                  value={codigoBipado}
                  onChange={(e) => setCodigoBipado(e.target.value)}
                  onKeyDown={(e) => {
                    // O leitor USB termina com Enter. Sem isto ele preencheria
                    // o campo e esperaria um clique que ninguém dá com a peça
                    // numa das mãos.
                    if (e.key === 'Enter') void bipar();
                  }}
                  placeholder="Bipe ou digite"
                />
              )}
            </Field>
            <Button variant="secondary" onClick={() => void bipar()}>
              Procurar
            </Button>
          </div>

          {scan?.foraDoAlcance && (
            <p className="mt-3 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
              Esse código é de uma peça de outra bancada. A gaveta de cada bancada é separada.
            </p>
          )}

          {scan?.encontrada && (
            <div className="mt-4 border-t border-[var(--gs-border)] pt-4">
              <p className="text-[length:var(--gs-text-sm)] m-0 mb-3">
                <strong>{scan.encontrada.name}</strong> — {scan.encontrada.available} disponível(is)
                de {scan.encontrada.stock_quantity} na gaveta
                {scan.encontrada.storage_location ? ` · ${scan.encontrada.storage_location}` : ''}
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Quantas chegaram">
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="decimal"
                      value={form.quantidade}
                      onChange={(e) => campo('quantidade', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Custo unitário (R$)" hint="Em branco, mantém o custo do cadastro.">
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="decimal"
                      value={form.custo}
                      onChange={(e) => campo('custo', e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label="% sobre o custo"
                  hint="Só com este campo o preço é recalculado. Em branco, o preço fica como está."
                >
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="decimal"
                      value={form.markup}
                      onChange={(e) => campo('markup', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Documento (nota, cupom ou recibo)">
                  {(p) => (
                    <Input
                      {...p}
                      value={form.nfNumero}
                      onChange={(e) => campo('nfNumero', e.target.value)}
                      placeholder="NF 12345"
                    />
                  )}
                </Field>
                <Field label="Fornecedor">
                  {(p) => (
                    <Input
                      {...p}
                      value={form.nfFornecedor}
                      onChange={(e) => campo('nfFornecedor', e.target.value)}
                    />
                  )}
                </Field>
                <Button
                  loading={ocupado}
                  onClick={() =>
                    void executar(async (chave) => {
                      const feita = await coreApi.reporPeca(
                        scan.encontrada!.id,
                        {
                          quantity: parseQuantity(form.quantidade) ?? 0,
                          costCents: form.custo.trim()
                            ? parseReaisToCents(form.custo)
                            : null,
                          markupPercent: form.markup.trim() ? markupNum : null,
                          documento: documento(),
                        },
                        chave,
                      );
                      setScan(null);
                      setCodigoBipado('');
                      setForm(VAZIO);
                      // A tela não pode dizer "reposta" quando nada somou.
                      if (feita.duplicada) return 'Esta entrada já tinha sido registrada.';
                      return feita.reprecificada
                        ? `Reposta. O preço passou para ${formatCents(feita.priceCents)}.`
                        : 'Reposta na gaveta.';
                    })
                  }
                >
                  Repor
                </Button>
              </div>
              {precoDerivado != null && form.custo.trim() && (
                <p className="mt-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Com {form.markup}% sobre {formatCents(custoCents)}, o preço passa a ser{' '}
                  <strong>{formatCents(precoDerivado)}</strong>.
                </p>
              )}
            </div>
          )}

          {scan && !scan.encontrada && !scan.foraDoAlcance && (
            <div className="mt-4 border-t border-[var(--gs-border)] pt-4">
              <p className="text-[length:var(--gs-text-sm)] m-0 mb-3">
                Código <strong className="font-mono">{scan.codigo}</strong> não está na gaveta.
                Cadastre a peça:
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Nome da peça">
                  {(p) => (
                    <Input {...p} value={form.nome} onChange={(e) => campo('nome', e.target.value)} />
                  )}
                </Field>
                {bancadas.length > 1 && (
                  <Field label="Bancada dona">
                    {(p) => (
                      <select
                        {...p}
                        className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-[var(--gs-surface)] px-3 py-2 text-[length:var(--gs-text-sm)]"
                        value={bancadaId}
                        onChange={(e) => setBancadaId(e.target.value)}
                      >
                        <option value="">Escolha…</option>
                        {bancadas.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                )}
                <Field label="Custo unitário (R$)">
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="decimal"
                      value={form.custo}
                      onChange={(e) => campo('custo', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="% sobre o custo" hint="O preço de venda sai desta conta.">
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="decimal"
                      value={form.markup}
                      onChange={(e) => campo('markup', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Quantas chegaram">
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="decimal"
                      value={form.quantidade}
                      onChange={(e) => campo('quantidade', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Mínimo (alerta)" hint="Abaixo disso a tela avisa que está acabando.">
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="decimal"
                      value={form.minimo}
                      onChange={(e) => campo('minimo', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Onde fica" hint="Ex: Prateleira A3 - Caixa 2">
                  {(p) => (
                    <Input
                      {...p}
                      value={form.local}
                      onChange={(e) => campo('local', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Documento (nota, cupom ou recibo)">
                  {(p) => (
                    <Input
                      {...p}
                      value={form.nfNumero}
                      onChange={(e) => campo('nfNumero', e.target.value)}
                      placeholder="NF 12345"
                    />
                  )}
                </Field>
                <Field label="Fornecedor">
                  {(p) => (
                    <Input
                      {...p}
                      value={form.nfFornecedor}
                      onChange={(e) => campo('nfFornecedor', e.target.value)}
                    />
                  )}
                </Field>
              </div>

              {precoDerivado != null && custoCents > 0 && (
                <p className="mt-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Custo {formatCents(custoCents)} + {form.markup}% ={' '}
                  <strong>{formatCents(precoDerivado)}</strong> de preço de venda.
                </p>
              )}

              <div className="mt-3 flex gap-3">
                <Button
                  loading={ocupado}
                  onClick={() =>
                    void executar(async (chave) => {
                      const criada = await coreApi.cadastrarPeca({
                        workshopId: bancadaId || bancadas[0]?.id || '',
                        name: form.nome,
                        barcode: scan.codigo,
                        costCents: custoCents,
                        markupPercent: form.markup.trim() ? markupNum : null,
                        priceCents: form.preco.trim() ? parseReaisToCents(form.preco) : null,
                        quantity: parseQuantity(form.quantidade) ?? 0,
                        minStock: form.minimo.trim() ? parseQuantity(form.minimo) : null,
                        storageLocation: form.local || null,
                        documento: documento(),
                      }, chave);
                      setScan(null);
                      setCodigoBipado('');
                      setForm(VAZIO);
                      if (criada.duplicada) return 'Esta peça já tinha sido cadastrada.';
                      return `Peça cadastrada por ${formatCents(criada.priceCents)}, com ${criada.quantity} na gaveta.`;
                    })
                  }
                >
                  Cadastrar e dar entrada
                </Button>
                <Button variant="secondary" onClick={() => setScan(null)}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card title="Na gaveta">
        <div className="mb-3">
          <SearchInput
            value={busca}
            onChange={setBusca}
            placeholder="Nome, código, barras ou prateleira…"
          />
        </div>

        {/*
          O MÍNIMO E O ENDEREÇO SÃO EDITÁVEIS DAQUI — e é por isso que a rota
          existe. Eles moravam no cadastro de PRODUTO, tela de gestão fechada
          para o mecânico: na prática ninguém preenchia, e o aviso de "está
          acabando" nunca disparava para a peça nascida de nota, que nasce com
          mínimo zero.

          O saldo NÃO se ajusta aqui de propósito: mudar quantidade sem
          movimento registrado seria o acerto de inventário sem o rastro que o
          acerto de inventário tem.
        */}
        {ajustando && (
          <div className="mb-4 border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-3">
            <p className="m-0 mb-3 text-[length:var(--gs-text-sm)]">
              Ajustando <strong>{ajustando.name}</strong>
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Mínimo (alerta)" hint="Zero significa que não há mínimo declarado.">
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={ajusteMinimo}
                    onChange={(e) => setAjusteMinimo(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Onde fica" hint="Em branco tira o endereço fixo.">
                {(p) => (
                  <Input
                    {...p}
                    value={ajusteLocal}
                    onChange={(e) => setAjusteLocal(e.target.value)}
                  />
                )}
              </Field>
              <Button
                loading={ocupado}
                onClick={() =>
                  void executar(async () => {
                    await coreApi.ajustarPeca(ajustando.id, {
                      minStock: ajusteMinimo.trim()
                        ? (parseQuantity(ajusteMinimo) ?? 0)
                        : 0,
                      storageLocation: ajusteLocal,
                    });
                    setAjustando(null);
                    return 'Peça ajustada.';
                  })
                }
              >
                Salvar
              </Button>
              <Button variant="secondary" onClick={() => setAjustando(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {pecas === null ? (
          falhou ? (
            // O erro já está dito no alto da página; aqui a tabela só sai do ar.
            <EmptyState
              title="Não deu para ler a gaveta"
              description="Tente de novo. Se continuar, avise quem cuida do sistema."
              action={
                <Button variant="secondary" onClick={() => void carregar()}>
                  Tentar de novo
                </Button>
              }
            />
          ) : (
            <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Carregando…
            </p>
          )
        ) : pecas.length === 0 ? (
          busca.trim() ? (
            // Busca sem resultado NÃO é gaveta vazia. Repetir aqui o texto de
            // "como se cadastra peça" faria a tela ensinar cadastro a quem só
            // digitou o nome errado do conector.
            <EmptyState
              title="Nada com esse nome"
              description={`Nenhuma peça da bancada bate com "${busca.trim()}". Tente o código, parte do nome ou a prateleira.`}
              action={
                <Button variant="secondary" onClick={() => setBusca('')}>
                  Ver a gaveta inteira
                </Button>
              }
            />
          ) : daEntrada ? (
            <EmptyState
              title="Nenhuma peça"
              description="Bipe o código da peça aí em cima para cadastrar a primeira. Peça que chega por nota do fornecedor também pode ser marcada como peça na conferência da nota."
              action={
                <Link to="/sistema/produtos">
                  <Button variant="secondary">Ir para os produtos</Button>
                </Link>
              }
            />
          ) : (
            <EmptyState
              title="Nenhuma peça"
              description="A gaveta desta bancada está vazia. Peça entra pela nota do fornecedor e é cadastrada por quem cuida do estoque — não dá para cadastrar por aqui."
            />
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Peça</th>
                  <th className="py-2">Código</th>
                  <th className="py-2">Onde fica</th>
                  <th className="py-2">Oficina</th>
                  <th className="py-2 text-right">Em estoque</th>
                  <th className="py-2 text-right">Disponível</th>
                  <th className="py-2 text-right">Mínimo</th>
                  {mostraCusto && <th className="py-2 text-right">Custo</th>}
                  {daEntrada && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {pecas.map((p) => (
                  <tr key={p.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">
                      {p.name}
                      {p.below_minimum && (
                        <span className="ml-2">
                          <Badge tone="warning">Repor</Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-[var(--gs-muted)]">{p.internal_code}</td>
                    <td className="py-2 text-[var(--gs-muted)]">{p.storage_location ?? '—'}</td>
                    <td className="py-2">{p.workshop_name ?? '—'}</td>
                    <td className="py-2 text-right">{p.stock_quantity}</td>
                    <td className="py-2 text-right">
                      <span
                        className={
                          p.below_minimum ? 'text-[var(--gs-warning)] font-semibold' : undefined
                        }
                      >
                        {p.available}
                      </span>
                      {p.reserved > 0 && (
                        <span className="text-[var(--gs-muted)]">
                          {' '}
                          ({p.reserved} prometida{p.reserved > 1 ? 's' : ''})
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right text-[var(--gs-muted)]">
                      {p.min_stock > 0 ? p.min_stock : '—'}
                    </td>
                    {mostraCusto && (
                      <td className="py-2 text-right">
                        {p.cost_cents === undefined ? '—' : formatCents(p.cost_cents)}
                      </td>
                    )}
                    {daEntrada && (
                      <td className="py-2 text-right">
                        <Button
                          variant="secondary"
                          onClick={() => abrirAjuste(p)}
                          aria-label={`Ajustar mínimo e endereço de ${p.name}`}
                        >
                          Ajustar
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!mostraCusto && pecas && pecas.length > 0 && (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            O custo da peça não aparece neste perfil.
          </p>
        )}
      </Card>
    </AppShell>
  );
}
