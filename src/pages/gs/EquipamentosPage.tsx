/**
 * Equipamentos da oficina.
 *
 * O equipamento é identificado pela PLAQUINHA (`#0001`), não pelo nome do dono
 * nem pelo modelo: duas motos iguais do mesmo cliente já causaram troca de peça
 * na bancada errada. O número vem do servidor, é global e não se repete.
 *
 * A tela existe porque o backend de equipamentos já está pronto e testado, mas
 * o menu ainda dizia "em breve" — quem precisava consultar uma plaquinha não
 * tinha por onde.
 *
 * ORIGEM é a distinção que o balcão precisa enxergar de longe:
 *  - INTERNO  — máquina do grupo, entra para venda;
 *  - CLIENTE  — máquina de terceiro, entrou para conserto e TEM QUE VOLTAR.
 * Confundir as duas é vender o equipamento de um cliente.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Kpi,
  PageHeader,
  SearchInput,
} from '@/components/gs/ui';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { coreApi, type Equipment } from '@/lib/api/core';
import { BuscaDeCliente, type Escolhido } from '@/components/gs/BuscaDeCadastro';
import { Paginacao } from '@/components/gs/Paginacao';
import { paginaDeEquipamentos, type Pagina } from '@/lib/api/paginas';
import { useHasProfile } from '@/hooks/useSession';
import { dataBR } from '@/lib/datas';
import { CampoBancada } from '@/components/gs/BancadaDeEntrada';
import { useBancadasDeEntrada } from '@/hooks/useBancadasDeEntrada';
import { precisaEscolherBancada } from '@/lib/api/oficinaEntrada';
import {
  CATEGORIAS_DE_EQUIPAMENTO,
  rotuloDaCategoria,
  temPlacaEKm,
} from '@/lib/api/equipamentoIdentidade';

const ORIGEM_ROTULO: Record<string, string> = {
  INTERNAL_PJ_MOTORS: 'Do grupo',
  EXTERNAL_CUSTOMER: 'De cliente',
};

/**
 * A GARANTIA vem DERIVADA do servidor — a conta é uma só, e não é aqui.
 *
 * A primeira versão desta coluna refazia a derivação no navegador, com o
 * argumento de que a tela precisa dizer "vence em 12 dias" enquanto o mecânico
 * olha. O argumento era falso: o servidor já responde `daysLeft` junto. E duas
 * contas para a mesma pergunta divergem no primeiro caso de borda — divergiram
 * no dia do vencimento, porque a data-base é dia de calendário e o navegador a
 * lia como meia-noite UTC, imprimindo o dia anterior no Brasil.
 *
 * Aqui só se traduz o que o servidor decidiu para o que a pessoa lê.
 */
function garantiaDe(eq: Equipment): {
  texto: string;
  detalhe: string | null;
  tom: 'neutral' | 'success' | 'warning' | 'danger';
} {
  const g = eq.warranty;
  if (!g || g.status === 'sem_garantia' || !g.expiresAt) {
    return { texto: 'Sem garantia', detalhe: null, tom: 'neutral' };
  }
  // `expiresAt` é dia de calendário (AAAA-MM-DD): vira 12/02/2027 sem passar
  // por `new Date`, que o leria como meia-noite UTC e recuaria um dia.
  const [ano, mes, dia] = g.expiresAt.split('-');
  const ate = `${dia}/${mes}/${ano}`;
  if (g.status === 'vencida') {
    return { texto: 'Vencida', detalhe: `em ${ate}`, tom: 'danger' };
  }
  if (g.status === 'vence_em_breve') {
    return { texto: `Vence em ${g.daysLeft}d`, detalhe: `até ${ate}`, tom: 'warning' };
  }
  return { texto: 'Em garantia', detalhe: `até ${ate}`, tom: 'success' };
}

/**
 * Situação de venda — três respostas, não duas.
 *
 * O banco guarda só `NOT_SOLD` / `SOLD`, e a tela lia esse par como se fosse a
 * pergunta inteira: tudo que não era `SOLD` virava "Disponível". Isso põe o
 * equipamento DE CLIENTE — a máquina que alguém trouxe para consertar e que tem
 * que voltar — na tela como coisa à venda. É o convite exato para vender o bem
 * de um terceiro, e nenhuma outra coluna desfaz esse convite, porque "Disponível"
 * é mais forte que um badge de origem ao lado.
 *
 * Então a origem vem PRIMEIRO: sendo do cliente, o campo não se aplica e a
 * resposta é "Não se aplica", com o motivo. Só a máquina do grupo tem as outras
 * duas respostas.
 *
 * `sold_at` acompanha "Vendido" porque é o que transforma um rótulo em fato
 * conferível: a garantia conta a partir dali, e quem atende no balcão precisa da
 * data, não da palavra.
 */
function situacaoVenda(eq: Equipment): { texto: string; detalhe: string | null; tom: 'neutral' | 'info' | 'success' } {
  if (eq.origin === 'EXTERNAL_CUSTOMER') {
    return { texto: 'Não se aplica', detalhe: 'máquina do cliente', tom: 'neutral' };
  }
  if (eq.sale_status === 'SOLD') {
    return {
      texto: 'Vendido',
      // A data pode faltar em plaquinha vendida à mão antes de o campo existir.
      // Melhor um "Vendido" sem data do que uma data inventada.
      detalhe: eq.sold_at ? `em ${dataBR(eq.sold_at)}` : null,
      tom: 'info',
    };
  }
  return { texto: 'Disponível', detalhe: null, tom: 'success' };
}

function identificacao(eq: Equipment): string {
  const partes = [eq.brand, eq.model, eq.color].filter(Boolean);
  return partes.length > 0 ? partes.join(' · ') : 'Sem descrição';
}

export default function EquipamentosPage() {
  const [itens, setItens] = useState<Equipment[] | null>(null);
  const [busca, setBusca] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);
  /** Os mesmos perfis que `POST /core/equipment` aceita. */
  const podeCadastrar = useHasProfile(
    'mecanico',
    'gerente_oficina',
    'operador_caixa_oficina',
    'atendente',
  );

  /*
    A PÁGINA E OS CARTÕES QUE CONTAVAM A PÁGINA (GAP-PRD-070).

    A lista parava em 300 e os três cartões somavam o que tinha chegado: com
    a 301ª plaquinha cadastrada, "Cadastrados" continuava dizendo 300. Os
    números agora vêm do servidor, no mesmo recorte da busca, e o rodapé anda.
  */
  const [pagina, setPagina] = useState<
    (Pagina<Equipment> & {
      totalPorOrigem: { INTERNAL_PJ_MOTORS: number; EXTERNAL_CUSTOMER: number } | null;
    }) | null
  >(null);
  const [offset, setOffset] = useState(0);

  const carregar = useCallback(async (termo: string, desde: number) => {
    setError(null);
    try {
      const recebida = await paginaDeEquipamentos({
        search: termo.trim() || undefined,
        offset: desde || undefined,
      });
      setItens(recebida.items);
      setPagina(recebida);
    } catch (err) {
      // A lista fica nula, não vazia: "nenhum equipamento" e "não consegui
      // carregar" são estados diferentes e não podem exibir a mesma coisa.
      setItens(null);
      setPagina(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar equipamentos.');
    }
  }, []);

  useEffect(() => {
    void carregar(busca, offset);
  }, [carregar, busca, offset]);

  const resumo = useMemo(() => {
    const lista = itens ?? [];
    const porOrigem = pagina?.totalPorOrigem;
    return {
      total: pagina?.totalConhecido ? pagina.total : lista.length,
      doGrupo: porOrigem
        ? porOrigem.INTERNAL_PJ_MOTORS
        : lista.filter((e) => e.origin === 'INTERNAL_PJ_MOTORS').length,
      deCliente: porOrigem
        ? porOrigem.EXTERNAL_CUSTOMER
        : lista.filter((e) => e.origin === 'EXTERNAL_CUSTOMER').length,
    };
  }, [itens, pagina]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Oficina', 'Equipamentos']}
        title="Equipamentos"
        /*
          O botão só existe para quem o servidor deixaria cadastrar.

          A tela é do ambiente de oficina E de gestão, e por ali entram gerente
          de loja e estoquista — que `POST /core/equipment` recusa. Sem esta
          guarda, o estoquista escolhia a origem, digitava marca, modelo,
          chassi, motor, garantia, datas e montador, clicava em salvar e lia
          "Permissão negada para esta operação." com tudo preenchido.
        */
        actions={
          podeCadastrar ? (
            <Button onClick={() => setAberto(true)}>Cadastrar equipamento</Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <Kpi label="Cadastrados" value={String(resumo.total)} />
        <Kpi label="Do grupo" value={String(resumo.doGrupo)} hint="Podem ser vendidos" />
        <Kpi
          label="De cliente"
          value={String(resumo.deCliente)}
          hint="Precisam voltar ao dono"
          tone="warning"
        />
      </div>

      {aberto && (
        <div className="mb-5">
          <NovoEquipamentoCard
            onCancelar={() => setAberto(false)}
            onCriado={() => {
              setAberto(false);
              void carregar(busca, offset);
            }}
          />
        </div>
      )}

      <Card
        title="Lista"
        subtitle="Busque pela plaquinha, marca, modelo, número de série ou chassi."
      >
        <div className="mb-4">
          <SearchInput
            value={busca}
            onChange={(valor) => {
              // Outra busca, outro universo: volta para a primeira página.
              setBusca(valor);
              setOffset(0);
            }}
            placeholder="Ex.: #0007, Honda, chassi…"
          />
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

        {itens && (
          <DataTable
            rows={itens}
            keyOf={(e) => e.id}
            empty={
              <EmptyState
                title={busca ? 'Nada encontrado' : 'Nenhum equipamento cadastrado'}
                description={
                  busca
                    ? 'Confira a plaquinha ou tente parte do modelo.'
                    : 'Cadastre o primeiro equipamento para gerar a plaquinha.'
                }
              />
            }
            columns={[
              {
                header: 'Plaquinha',
                render: (e) => (
                  // O número abre a FICHA (rodada 52): garantia, quem montou e
                  // tudo o que já aconteceu com aquela máquina.
                  <Link
                    to={`/sistema/equipamentos/${e.id}`}
                    className="font-semibold tabular-nums text-[var(--gs-purple-800)] no-underline hover:underline"
                  >
                    {e.publicIdLabel}
                  </Link>
                ),
              },
              {
                header: 'Equipamento',
                render: (e) => (
                  <div className="flex flex-col">
                    <span className="font-semibold">{identificacao(e)}</span>
                    {e.category && (
                      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        {rotuloDaCategoria(e.category)}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Origem',
                render: (e) => (
                  <Badge tone={e.origin === 'EXTERNAL_CUSTOMER' ? 'warning' : 'info'}>
                    {ORIGEM_ROTULO[e.origin] ?? e.origin}
                  </Badge>
                ),
              },
              {
                header: 'Série / Chassi',
                render: (e) => (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                    {e.serial_number || e.chassis || '—'}
                  </span>
                ),
              },
              {
                /*
                  ESTOQUE — a moto que também é uma UNIDADE da loja.

                  Sem esta coluna, a bancada não tem como distinguir a moto que
                  está à venda no balcão da moto interna solta: as duas aparecem
                  como "Do grupo · Disponível". A diferença importa porque a
                  vinculada some do pátio no dia em que alguém a comprar, e
                  porque a identidade dela passa a ser corrigida pela loja.

                  O nome da empresa vai junto porque a unidade vive em OUTRA
                  empresa do grupo — quem lê precisa saber de qual loja.

                  Todos os quatro campos chegam pelo caminho da UNIDADE:
                  `listEquipment` faz `LEFT JOIN core_product_units u ON
                  u.equipment_id = e.id` e, dali, `JOIN core_products p ON
                  p.id = u.product_id`. `core_equipment.linked_product_id` não
                  participa disso e já não é escrito por ninguém — o vínculo
                  grava só `origin_company_id`.
                */
                header: 'Estoque',
                render: (e) =>
                  e.estoque ? (
                    <div className="flex flex-col">
                      <span className="text-[length:var(--gs-text-sm)]">{e.estoque.productName}</span>
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        {e.estoque.companyName} ·{' '}
                        {e.estoque.unitStatus === 'in_stock'
                          ? 'em estoque'
                          : e.estoque.unitStatus === 'sold'
                            ? 'vendida'
                            : 'baixada'}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">—</span>
                  ),
              },
              {
                header: 'Garantia',
                render: (e) => {
                  const g = garantiaDe(e);
                  return (
                    <div className="flex flex-col gap-1 items-start">
                      <Badge tone={g.tom}>{g.texto}</Badge>
                      {g.detalhe && (
                        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                          {g.detalhe}
                        </span>
                      )}
                    </div>
                  );
                },
              },
              {
                header: 'Venda',
                render: (e) => {
                  const situacao = situacaoVenda(e);
                  return (
                    <div className="flex flex-col gap-1 items-start">
                      <Badge tone={situacao.tom}>{situacao.texto}</Badge>
                      {situacao.detalhe && (
                        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                          {situacao.detalhe}
                        </span>
                      )}
                    </div>
                  );
                },
              },
            ]}
          />
        )}
        <Paginacao
          pagina={pagina ? { ...pagina, quantidade: pagina.items.length } : null}
          rotulo={{ singular: 'equipamento', plural: 'equipamentos' }}
          onMudar={setOffset}
          dica="A busca pela plaquinha, marca ou chassi vai direto à máquina."
        />
      </Card>
    </AppShell>
  );
}

/**
 * Cadastro.
 *
 * Dos dados da máquina, nenhum é obrigatório, e de propósito: ela costuma
 * chegar antes dos documentos, e exigir chassi no balcão faria o atendente
 * inventar um. O que não pode ficar em branco é DE QUEM ELA É — e, sendo de
 * cliente, QUAL cliente: o servidor recusa equipamento externo sem dono, e com
 * razão, porque máquina de terceiro sem nome ninguém sabe devolver.
 */
function NovoEquipamentoCard({
  onCancelar,
  onCriado,
}: {
  onCancelar: () => void;
  onCriado: () => void;
}) {
  const [origem, setOrigem] = useState<'INTERNAL_PJ_MOTORS' | 'EXTERNAL_CUSTOMER'>(
    'EXTERNAL_CUSTOMER',
  );
  /*
    O DONO POR BUSCA (GAP-PRD-070): o seletor trazia os 100 primeiros
    clientes, e a máquina do 101º não tinha como ser cadastrada com dono.
  */
  const [dono, setDono] = useState<Escolhido | null>(null);
  const donoId = dono?.id ?? '';
  const [campos, setCampos] = useState({
    category: '',
    brand: '',
    model: '',
    year: '',
    version: '',
    color: '',
    serialNumber: '',
    motorNumber: '',
    chassis: '',
    battery: '',
    batterySerial: '',
    notes: '',
    // A ficha completa da máquina (rodada 52).
    warrantyMonths: '',
    enteredAt: '',
    assembledAt: '',
    // Placa e quilometragem da MÁQUINA (GAP-PRD-106).
    plate: '',
    odometerKm: '',
  });
  const [montadorId, setMontadorId] = useState('');
  /** A plaquinha já colada na máquina, escolhida do pool (rodada 53). */
  const [plaquinhaId, setPlaquinhaId] = useState('');
  const [livres, setLivres] = useState<{ public_id: number; publicIdLabel: string }[]>([]);
  const [equipe, setEquipe] = useState<{ id: string; displayName: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
    A BANCADA DA MÁQUINA (GAP-PRD-099): o servidor diz onde quem cadastra
    pode registrar — o balcão tem a empresa, o mecânico a filiação —, e a
    pergunta só aparece com mais de uma bancada no alcance.
  */
  const bancadas = useBancadasDeEntrada(true);
  const [bancadaId, setBancadaId] = useState('');

  const set = (chave: keyof typeof campos) => (valor: string) =>
    setCampos((atual) => ({ ...atual, [chave]: valor }));

  useEffect(() => {
    // A equipe da bancada, para dizer quem montou. Falha aqui não trava o
    // cadastro: o montador pode ser preenchido depois, na ficha.
    void apiRequest<{ items: { id: string; displayName: string }[] }>(
      '/core/team?workshopStaff=1',
    )
      .then((r) => setEquipe(r.items ?? []))
      .catch(() => setEquipe([]));

    /*
      As plaquinhas LIVRES — os adesivos que já estão impressos e esperando
      máquina (rodada 53).

      Falha aqui também não trava: quem não usa plaquinha, ou quem ainda não
      gerou lote nenhum, cadastra do jeito de sempre e o número é sorteado.
    */
    void apiRequest<{ items: { public_id: number; publicIdLabel: string }[] }>(
      '/core/equipment-tags?status=disponivel',
    )
      .then((r) => setLivres(r.items ?? []))
      .catch(() => setLivres([]));
  }, []);

  const salvar = useCallback(async () => {
    // Barra aqui o que o servidor barraria de qualquer jeito, para o atendente
    // não preencher a ficha inteira antes de descobrir.
    if (origem === 'EXTERNAL_CUSTOMER' && !donoId) {
      setError('Escolha o cliente dono do equipamento.');
      return;
    }
    const escolhe = precisaEscolherBancada(bancadas);
    if (escolhe && !bancadaId) {
      setError('Escolha a bancada da máquina.');
      return;
    }
    // "Outro" sozinho não identifica máquina nenhuma (a mesma regra do servidor).
    if (campos.category === 'outro' && !campos.brand.trim() && !campos.model.trim()) {
      setError('Para o tipo "Outro", informe ao menos a marca ou o modelo.');
      return;
    }
    const comPlacaEKm = temPlacaEKm(campos.category);
    setBusy(true);
    setError(null);
    try {
      await coreApi.createEquipment({
        workshopId: escolhe ? bancadaId : undefined,
        origin: origem,
        ...campos,
        // Tipo em branco não viaja: o cadastro sem tipo continua valendo.
        category: campos.category || undefined,
        // Celular não tem placa nem km: nem viajam.
        plate: comPlacaEKm && campos.plate.trim() ? campos.plate.trim() : undefined,
        odometerKm:
          comPlacaEKm && campos.odometerKm.trim() ? Number(campos.odometerKm) : undefined,
        // O ano viaja como número — e em branco não viaja, para não virar 0.
        year: campos.year.trim() ? Number(campos.year) : undefined,
        // Garantia e datas: em branco não viajam — o servidor recusaria uma
        // string vazia como data, e "sem garantia" é ausência, não zero.
        warrantyMonths: campos.warrantyMonths.trim()
          ? Number(campos.warrantyMonths)
          : undefined,
        enteredAt: campos.enteredAt || undefined,
        assembledAt: campos.assembledAt || undefined,
        assemblyMechanicId: montadorId || null,
        ownerCustomerId: origem === 'EXTERNAL_CUSTOMER' ? donoId : null,
        // A plaquinha JÁ COLADA na máquina (rodada 53). Em branco, o número é
        // sorteado como sempre foi — e o pool registra os dois caminhos.
        tagPublicId: plaquinhaId ? Number(plaquinhaId) : undefined,
      });
      onCriado();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao cadastrar.');
    } finally {
      setBusy(false);
    }
  }, [origem, campos, donoId, montadorId, plaquinhaId, onCriado, bancadas, bancadaId]);

  return (
    <Card
      title="Novo equipamento"
      subtitle={
        livres.length > 0
          ? 'Informe a plaquinha que já está colada na máquina, ou deixe em branco para o sistema '
            + 'gerar o número.'
          : 'A plaquinha é gerada pelo sistema ao salvar.'
      }
    >
      <div className="flex flex-col gap-4">
        <CampoBancada bancadas={bancadas} value={bancadaId} onChange={setBancadaId} />
        {/*
          A PLAQUINHA QUE JÁ ESTÁ NA MÁQUINA (rodada 53).

          O campo só aparece quando há adesivo livre no pool: oferecer um
          seletor vazio ensinaria que falta preencher algo que não existe. Em
          branco, o número é sorteado — que é como o sistema sempre funcionou.
        */}
        {livres.length > 0 && (
          <Field
            label="Plaquinha colada na máquina"
            hint="Só aparecem as já impressas e liberadas. Em branco, o sistema gera o número."
          >
            {(p) => (
              <select
                {...p}
                value={plaquinhaId}
                onChange={(e) => setPlaquinhaId(e.target.value)}
                className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
              >
                <option value="">Gerar um número novo</option>
                {livres.map((t) => (
                  <option key={t.public_id} value={String(t.public_id)}>
                    {t.publicIdLabel}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {/* Grupo de escolha exclusiva: `radiogroup` para o leitor de tela
            anunciar que são alternativas, não dois botões de ação. */}
        <Field label="De quem é" hint="Máquina de cliente não pode ser vendida.">
          {({ id, 'aria-describedby': describedBy }) => (
            <div
              id={id}
              role="radiogroup"
              aria-describedby={describedBy}
              className="flex gap-2 flex-wrap"
            >
              {(['EXTERNAL_CUSTOMER', 'INTERNAL_PJ_MOTORS'] as const).map((opcao) => (
                <Button
                  key={opcao}
                  role="radio"
                  aria-checked={origem === opcao}
                  variant={origem === opcao ? 'primary' : 'ghost'}
                  onClick={() => setOrigem(opcao)}
                >
                  {ORIGEM_ROTULO[opcao]}
                </Button>
              ))}
            </div>
          )}
        </Field>

        {/* Só faz sentido para máquina de terceiro. Para a do grupo, o campo
            não aparece em vez de aparecer desabilitado: menos ruído na ficha. */}
        {origem === 'EXTERNAL_CUSTOMER' && (
          <BuscaDeCliente
            rotulo="Cliente dono"
            obrigatorio
            valor={dono}
            aoMudar={(c) => setDono(c ? { id: c.id, nome: c.name } : null)}
            dica="Sem dono não há para quem devolver. Busque por nome, CPF, telefone ou código — quem não aparece precisa ser cadastrado antes."
          />
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/*
            O TIPO É DO VOCABULÁRIO (GAP-PRD-106): era texto livre, e cada
            atendente escrevia de um jeito. Ele decide o que a ficha pergunta:
            celular não tem placa nem quilometragem; "Outro" pede marca ou modelo.
          */}
          <Field label="Tipo" hint="Decide o que a ficha pergunta.">
            {(props) => (
              <select
                {...props}
                value={campos.category}
                onChange={(e) => set('category')(e.target.value)}
                className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
              >
                <option value="">Não informado</option>
                {CATEGORIAS_DE_EQUIPAMENTO.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {temPlacaEKm(campos.category) && (
            <Field label="Placa" hint="ABC1234 ou Mercosul ABC1D23. Em branco se não tiver.">
              {(props) => (
                <Input
                  {...props}
                  value={campos.plate}
                  placeholder="ABC1D23"
                  onChange={(e) => set('plate')(e.target.value.toUpperCase())}
                />
              )}
            </Field>
          )}
          {temPlacaEKm(campos.category) && (
            <Field label="Quilometragem" hint="O que o painel mostra na entrada.">
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  value={campos.odometerKm}
                  placeholder="1200"
                  onChange={(e) => set('odometerKm')(e.target.value.replace(/\D/g, '').slice(0, 7))}
                />
              )}
            </Field>
          )}
          <Field label="Marca">
            {(props) => (
              <Input
                {...props}
                value={campos.brand}
                onChange={(e) => set('brand')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Modelo">
            {(props) => (
              <Input
                {...props}
                value={campos.model}
                onChange={(e) => set('model')(e.target.value)}
              />
            )}
          </Field>
          {/* Ano e versão existiam no serviço desde o início — sem campo na
              tela, morriam no caminho até esta rodada. */}
          <Field label="Ano de fabricação">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                placeholder="2024"
                value={campos.year}
                onChange={(e) => set('year')(e.target.value.replace(/\D/g, '').slice(0, 4))}
              />
            )}
          </Field>
          <Field label="Versão">
            {(props) => (
              <Input
                {...props}
                value={campos.version}
                onChange={(e) => set('version')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Cor">
            {(props) => (
              <Input
                {...props}
                value={campos.color}
                onChange={(e) => set('color')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Número de série">
            {(props) => (
              <Input
                {...props}
                value={campos.serialNumber}
                onChange={(e) => set('serialNumber')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Chassi">
            {(props) => (
              <Input
                {...props}
                value={campos.chassis}
                onChange={(e) => set('chassis')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Número do motor">
            {(props) => (
              <Input
                {...props}
                value={campos.motorNumber}
                onChange={(e) => set('motorNumber')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Bateria">
            {(props) => (
              <Input
                {...props}
                placeholder="60V 30Ah"
                value={campos.battery}
                onChange={(e) => set('battery')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Série da bateria">
            {(props) => (
              <Input
                {...props}
                value={campos.batterySerial}
                onChange={(e) => set('batterySerial')(e.target.value)}
              />
            )}
          </Field>
        </div>

        <Field label="Observações" hint="Avarias e faltas vistas na entrada.">
          {(props) => (
            <Input
              {...props}
              value={campos.notes}
              onChange={(e) => set('notes')(e.target.value)}
            />
          )}
        </Field>

        {/*
          GARANTIA E MONTAGEM (rodada 52).

          Guarda-se o combinado — quantos meses —, nunca o estado: o sistema
          anterior gravava "em garantia" à mão e nunca recalculava, e a moto
          seguia em garantia na tela anos depois de vencer. Aqui a conta é
          refeita toda vez que alguém abre a ficha.
        */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Garantia (meses)"
            hint="Em branco = sem garantia da casa."
          >
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                placeholder="12"
                value={campos.warrantyMonths}
                onChange={(e) =>
                  set('warrantyMonths')(e.target.value.replace(/\D/g, '').slice(0, 3))
                }
              />
            )}
          </Field>
          <Field
            label="Entrou em"
            hint="Aquisição pela loja, ou recebimento do cliente."
          >
            {(props) => (
              <Input
                {...props}
                type="date"
                value={campos.enteredAt}
                onChange={(e) => set('enteredAt')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Montada em" hint="Só para máquina montada aqui.">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={campos.assembledAt}
                onChange={(e) => set('assembledAt')(e.target.value)}
              />
            )}
          </Field>
        </div>

        <Field
          label="Montada por"
          hint="Quem responde pela montagem quando a máquina volta."
        >
          {(props) => (
            <select
              {...props}
              value={montadorId}
              onChange={(e) => setMontadorId(e.target.value)}
              className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            >
              <option value="">Não informado</option>
              {equipe.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          )}
        </Field>

        {error && (
          <p
            role="alert"
            className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]"
          >
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <Button loading={busy} onClick={() => void salvar()}>
            Salvar e gerar plaquinha
          </Button>
          <Button variant="ghost" onClick={onCancelar}>
            Cancelar
          </Button>
        </div>
      </div>
    </Card>
  );
}
