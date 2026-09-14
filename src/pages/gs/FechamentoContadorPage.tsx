/**
 * FECHAMENTO DO CONTADOR — o mês inteiro num arquivo só.
 *
 * ## O gesto que esta tela substitui
 *
 * Todo mês alguém tem que mandar ao contador o que a empresa emitiu, o que
 * recebeu e o que apurou. Hoje isso é feito clicando arquivo por arquivo em
 * três telas diferentes — e o que não tem botão simplesmente não é entregue.
 * Aqui é um clique, e o que sai é um zip com pastas nomeadas em português.
 *
 * ## A METADE QUE NINGUÉM COSTUMA CONSTRUIR: dizer o que NÃO tem
 *
 * O servidor escreve dentro do pacote um LEIA-ME com as lacunas. Esta tela faz
 * a mesma coisa ANTES do download, com as pendências da prévia, porque
 * descobrir a lacuna depois de já ter mandado o arquivo ao contador é tarde.
 *
 * E nenhuma pendência bloqueia o botão. Isso é decisão, não esquecimento: no
 * banco real desta empresa não há uma única nota emitida, então um critério do
 * tipo "não fecha sem emissão" reprovaria todos os meses, todos os meses — e
 * um alerta que sempre acende deixa de ser lido em duas semanas. Quem lê
 * decide; o sistema informa.
 *
 * ## O SELETOR ABRE ONDE TEM MATÉRIA-PRIMA
 *
 * A prévia traz `mesesComMateriaPrima`, do mais recente para o mais antigo.
 * Abrir sempre no mês corrente, num sistema cuja única nota é de meses atrás,
 * mostraria um pacote vazio e faria quem clicou concluir que a função não
 * funciona. Então: carrega o mês corrente, e se ele não estiver na lista e a
 * lista não for vazia, pula para o primeiro dela. Lista vazia é resposta
 * legítima — significa "não há nada em mês nenhum" — e aí fica-se no mês
 * corrente mesmo, dizendo isso em palavras.
 *
 * ## O DOWNLOAD NÃO PODE SER UM LINK
 *
 * `authMiddleware` lê o token só do cabeçalho `Authorization`. Um `<a href>`
 * para a rota do zip recebe 401. Por isso `apiBinary` + `salvarArquivo`: busca
 * com o Bearer, vira Blob, e só então ganha um endereço `blob:`. O nome do
 * arquivo vem do `Content-Disposition`, que o servidor expõe ao JavaScript por
 * `exposedHeaders` no CORS.
 *
 * ## A MESMA TELA PARA DOIS PÚBLICOS — e por que não são duas
 *
 * Desde a rodada 29 esta é a casa do perfil `contador` (`CASA.contabilidade`)
 * e a ÚNICA tela que ele alcança no sistema inteiro. Ela não muda de forma
 * para ele, de propósito: o gerente e o contador precisam exatamente do mesmo
 * — o que o mês tem, o que falta nele, e o arquivo. Uma segunda tela "do
 * contador" divergiria da primeira no primeiro ajuste, e o pior momento para
 * descobrir que os dois lados estão olhando contagens diferentes é a discussão
 * sobre o que foi entregue.
 *
 * ## O XML AVULSO DA NOTA RECEBIDA NÃO TEM BOTÃO AQUI, E NÃO É ESQUECIMENTO
 *
 * O servidor abriu `GET /core/purchases/notes/:id/xml` ao contador nesta
 * mesma rodada, e a tela que lista notas recebidas (`EntradaNotasPage`) é do
 * escritório — ele não a alcança. Restava esta tela como origem do botão, e
 * ela NÃO TEM DE ONDE TIRAR O `:id`:
 *
 *   - `previaDoFechamento` devolve CONTAGENS (`recebidasComArquivo`,
 *     `recebidasSemArquivo`, `recebidasSemNota`, `recebidasEstornadas`) e
 *     nenhuma lista de notas — conferido no serviço,
 *     em `server/src/services/core/FiscalClosingService.ts`;
 *   - o `MANIFESTO.csv` de dentro do pacote referencia cada nota pela CHAVE DE
 *     ACESSO, e a rota pede o `id` interno da linha de `core_inbound_notes`.
 *     São identificadores diferentes, e não há rota que traduza um no outro.
 *
 * Inventar um campo "cole aqui o id da nota" seria pior que a ausência: um
 * formulário que ninguém consegue preencher, porque o contador nunca viu esse
 * id em lugar nenhum. E ele não fica sem o arquivo: todo XML de compra do
 * período já viaja dentro do pacote, na pasta `recebidas/`.
 *
 * O que falta para o botão existir é uma lista de notas recebidas do período
 * NA PRÉVIA — decisão de servidor, e ela está relatada como pendência da
 * rodada. Enquanto não vier, a rota aberta é alcançável e inútil para ele, o
 * que é seguro (ela só devolve nota da empresa dele) mas está escrito aqui
 * para que a próxima pessoa não conclua que a tela deixou o botão cair.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Button, Card, EmptyState, Kpi, PageHeader } from '@/components/gs/ui';
import { ApiRequestError, apiBinary, apiRequest, exigirCampos, getSession } from '@/lib/api/client';
import { salvarArquivo } from '@/lib/download';
import { ConferirPacoteCard } from '@/components/gs/ConferirPacoteCard';
import { CABECALHO_DO_HASH } from '@/lib/api/pacoteDoContador';

/** Uma lacuna do mês. Nenhuma impede o download — ver o cabeçalho. */
interface Pendencia {
  codigo: string;
  titulo: string;
  detalhe: string;
  quantidade: number;
}

interface Previa {
  period: string;
  primeiroDia: string;
  ultimoDia: string;
  empresa: { nome: string; slug: string };
  nomeArquivo: string;
  contagens: {
    emitidasAutorizadas: number;
    emitidasCanceladas: number;
    eventos: number;
    recebidasComArquivo: number;
    recebidasSemArquivo: number;
    /*
      AS DUAS AUSÊNCIAS QUE SAÍRAM DO BALDE DO "SEM ARQUIVO".

      `recebidasSemArquivo` contava três fatos diferentes até o serviço
      separá-los: o XML perdido (nota pré-v58), a compra SEM nota fiscal
      (entrada manual, que nunca teve arquivo) e a entrada ESTORNADA
      (documento morto). Hoje ele conta só o primeiro.

      OPCIONAIS de propósito: a tela precisa continuar montando contra uma
      resposta antiga em cache, e `undefined` aqui significa "esta versão do
      servidor ainda não separava", não "zero".
    */
    recebidasSemNota?: number;
    recebidasEstornadas?: number;
    faixasInutilizadas: number;
  };
  pendencias: Pendencia[];
  mesesComMateriaPrima: string[];
}

/*
  ==========================================================================
  O ENVIO AO CONTADOR (GAP-V30/V31) — a metade da tela que é SÓ DA GESTÃO
  ==========================================================================

  A tela tem dois públicos (ver o cabeçalho), e o envio pertence a um deles:
  decidir PARA ONDE a contabilidade vai, QUANDO vai sozinha e mandá-la agora é
  de quem responde pela operação — as rotas novas nomeiam só os gerentes, e o
  contador (a pessoa de fora que RECEBE) tomaria 403 em cada uma. Por isso a
  seção inteira é condicionada ao perfil: oferecer o formulário a quem o
  servidor recusa é a porta que bate na cara, proibida desde a rodada 23.
*/

interface Destinatario {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

interface Agenda {
  dayOfMonth: number;
  active: boolean;
  lastSentPeriod: string | null;
  lastError: string | null;
}

interface EnvioDoMes {
  id: string;
  name: string;
  email: string;
  origem: 'manual' | 'agenda';
  status: 'pendente' | 'enviado' | 'falhou' | 'sem_registro';
  erro: string | null;
  enviadoEm: string | null;
  criadoEm: string;
}

interface EnviosDoMes {
  items: EnvioDoMes[];
  carteiro: { readiness: 'READY' | 'READY_FOR_CREDENTIAL'; missing: string[] };
}

/** O estado do envio em palavras de balcão — o mapa é fechado de propósito. */
const ROTULO_DO_STATUS: Record<EnvioDoMes['status'], string> = {
  pendente: 'na fila (aguardando o carteiro)',
  enviado: 'enviado',
  falhou: 'falhou',
  sem_registro: 'sem registro na fila',
};

/** O mês de hoje em 'AAAA-MM' — o ponto de partida antes de a prévia chegar. */
function mesCorrente(): string {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
}

const NOMES_DOS_MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/**
 * 'AAAA-MM' em português.
 *
 * A conta é feita sobre o TEXTO, e não passando por `new Date`, porque
 * `new Date('2026-04')` é interpretado como meia-noite UTC — e num fuso a
 * oeste isso volta como 31 de março. O seletor mostraria um mês e baixaria
 * outro, que é o tipo de erro que só aparece na contabilidade.
 */
function mesPorExtenso(period: string): string {
  const indice = Number(period.slice(5, 7)) - 1;
  const nome = NOMES_DOS_MESES[indice];
  return nome ? `${nome} de ${period.slice(0, 4)}` : period;
}

/**
 * ============================================================================
 * O NÚMERO QUE O SERVIDOR NÃO MANDOU NÃO É ZERO
 * ============================================================================
 *
 * `recebidasSemNota` e `recebidasEstornadas` são OPCIONAIS na interface acima
 * porque um servidor anterior à separação dos baldes simplesmente não os manda
 * — e uma resposta em cache é o caso real, não o hipotético.
 *
 * Escrever `0` nesse tile seria a tela AFIRMAR, com a autoridade de um número
 * grande no meio da grade, que não houve compra sem nota fiscal no mês. O que
 * houve foi uma pergunta que ninguém respondeu. O travessão diz isso, e o hint
 * do tile diz por quê — "vazio" e "não consegui perguntar" são estados
 * diferentes, e a diferença aqui muda o que o contador vai escriturar.
 */
function contagemOuNaoSei(quantos: number | undefined): string {
  return quantos === undefined ? '—' : String(quantos);
}

/** O hint de um tile cujo número o servidor desta versão não separa. */
const NAO_SEPARADO_POR_ESTE_SERVIDOR =
  'Esta versão do servidor ainda não separa este balde — a tela não sabe a contagem, e não sabe '
  + 'é diferente de zero. O número está somado em "Compras sem XML".';

export default function FechamentoContadorPage() {
  const [periodo, setPeriodo] = useState<string>(mesCorrente);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [baixando, setBaixando] = useState(false);
  /** O SHA-256 do último zip baixado, como o servidor o disse (GAP-PRD-176). */
  const [hashDoDownload, setHashDoDownload] = useState<{ nomeArquivo: string; sha256: string } | null>(
    null,
  );
  const [mensagem, setMensagem] = useState<{ tom: 'ok' | 'erro' | 'info'; texto: string } | null>(
    null,
  );

  /*
    Quem NÃO é o contador é gestão: só os quatro perfis de
    `QUEM_ENTREGA_A_CONTABILIDADE` chegam nesta tela, e as rotas do envio
    aceitam exatamente os quatro menos ele. A seção do envio segue este
    booleano — e os efeitos também, para o contador não disparar chamadas que
    voltariam 403.
  */
  const souDaGestao = (getSession()?.user.profileCode ?? '') !== 'contador';

  const [destinatarios, setDestinatarios] = useState<Destinatario[]>([]);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [envios, setEnvios] = useState<EnviosDoMes | null>(null);
  const [novoNome, setNovoNome] = useState('');
  const [novoEmail, setNovoEmail] = useState('');
  const [agendaDia, setAgendaDia] = useState(5);
  const [agendaAtiva, setAgendaAtiva] = useState(false);
  const [trabalhandoNoEnvio, setTrabalhandoNoEnvio] = useState(false);

  const carregarEnvio = useCallback(async (alvo: string) => {
    // As três leituras falham juntas ou separadas sem derrubar a tela: o
    // fechamento em si (prévia + download) não depende de nenhuma delas.
    try {
      const [dest, ag, env] = await Promise.all([
        apiRequest<{ items: Destinatario[] }>('/core/fiscal/contador/destinatarios'),
        apiRequest<{ agenda: Agenda | null }>('/core/fiscal/contador/agenda'),
        apiRequest<EnviosDoMes>(`/core/fiscal/closings/${alvo}/envios`),
      ]);
      // `items` ausente é CONTRATO QUEBRADO, e o desembrulho cru o transformava
      // em `undefined` que só estourava no render (`destinatarios.filter`), com
      // a tela inteira caindo longe da causa. Aqui a falta vira erro que o
      // `catch` abaixo trata como as outras — a seção mostra vazio e o
      // fechamento continua de pé.
      setDestinatarios(exigirCampos(dest, 'items').items);
      setAgenda(ag.agenda);
      if (ag.agenda) {
        setAgendaDia(ag.agenda.dayOfMonth);
        setAgendaAtiva(ag.agenda.active);
      }
      setEnvios(env);
    } catch {
      // Sem rede ou sem permissão: a seção mostra o vazio, o resto da tela
      // continua inteiro. O erro de uma AÇÃO (enviar, salvar) fala; o de
      // leitura de fundo não vira banner.
    }
  }, []);

  useEffect(() => {
    if (souDaGestao) void carregarEnvio(periodo);
  }, [periodo, souDaGestao, carregarEnvio]);

  const adicionarDestinatario = async () => {
    setTrabalhandoNoEnvio(true);
    setMensagem(null);
    try {
      await apiRequest('/core/fiscal/contador/destinatarios', {
        method: 'POST',
        body: { name: novoNome, email: novoEmail },
      });
      setNovoNome('');
      setNovoEmail('');
      await carregarEnvio(periodo);
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao cadastrar o destinatário.',
      });
    } finally {
      setTrabalhandoNoEnvio(false);
    }
  };

  const alternarDestinatario = async (dest: Destinatario) => {
    try {
      await apiRequest(`/core/fiscal/contador/destinatarios/${dest.id}`, {
        method: 'PATCH',
        body: { active: !dest.active },
      });
      await carregarEnvio(periodo);
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao atualizar o destinatário.',
      });
    }
  };

  const salvarAgenda = async () => {
    setTrabalhandoNoEnvio(true);
    setMensagem(null);
    try {
      const r = await apiRequest<{ agenda: Agenda }>('/core/fiscal/contador/agenda', {
        method: 'PUT',
        body: { dayOfMonth: agendaDia, active: agendaAtiva },
      });
      setAgenda(r.agenda);
      setMensagem({
        tom: 'ok',
        texto: r.agenda.active
          ? `Envio automático ligado: todo dia ${r.agenda.dayOfMonth} sai o fechamento do mês anterior.`
          : 'Envio automático desligado. O envio manual continua disponível.',
      });
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao salvar a agenda.',
      });
    } finally {
      setTrabalhandoNoEnvio(false);
    }
  };

  const enviarPorEmail = async () => {
    if (!previa) return;
    setTrabalhandoNoEnvio(true);
    setMensagem(null);
    try {
      /*
        A chave de idempotência nasce no CLIQUE: o retry de rede da mesma
        intenção não duplica o e-mail; um segundo clique consciente (chave
        nova) é reenvio legítimo — o pacote é derivado e re-gerável.
      */
      const r = await apiRequest<{ enfileirados: number; duplicados: number; comAnexo: boolean }>(
        `/core/fiscal/closings/${previa.period}/enviar`,
        { method: 'POST', body: { idempotencyKey: crypto.randomUUID() } },
      );
      const carteiroParado = envios?.carteiro.readiness !== 'READY';
      setMensagem({
        tom: 'ok',
        texto:
          `${r.enfileirados} e-mail(s) do pacote de ${mesPorExtenso(previa.period)} entraram na fila`
          + (r.comAnexo ? ', com o zip anexado. ' : ' — SEM anexo: o mês passou do tamanho de e-mail; o contador baixa pelo sistema. ')
          + (carteiroParado
            ? 'O carteiro ainda não tem credencial SMTP: a fila acumula e envia quando ela existir.'
            : 'O carteiro entrega na próxima batida.'),
      });
      await carregarEnvio(periodo);
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao enfileirar o envio.',
      });
    } finally {
      setTrabalhandoNoEnvio(false);
    }
  };

  /**
   * O pulo para o mês com matéria-prima acontece UMA vez.
   *
   * Sem esta trava, quem escolhesse à mão um mês vazio seria jogado de volta
   * para o mês cheio no instante seguinte — a tela desobedeceria a escolha da
   * pessoa e pareceria quebrada.
   */
  const jaPulou = useRef(false);

  const carregarPrevia = useCallback(async (alvo: string) => {
    setCarregando(true);
    try {
      const r = await apiRequest<Previa>(`/core/fiscal/closings/${alvo}/previa`);

      const [maisRecente] = r.mesesComMateriaPrima;
      const vaiPular = !jaPulou.current && !!maisRecente && !r.mesesComMateriaPrima.includes(alvo);
      jaPulou.current = true;
      if (vaiPular) {
        /*
          Sai SEM publicar esta prévia e SEM desligar o "carregando".

          Publicá-la desenharia por um instante o mês vazio que estamos
          justamente abandonando — a grade inteira zerada, piscando antes do mês certo. E
          desligar o carregando abriria um quadro sem tela nenhuma entre as
          duas requisições. O efeito de `periodo` recomeça daqui.
        */
        setPeriodo(maisRecente);
        return;
      }

      setPrevia(r);
      setCarregando(false);
    } catch (err) {
      setPrevia(null);
      setCarregando(false);
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao carregar a prévia do mês.',
      });
    }
  }, []);

  useEffect(() => {
    void carregarPrevia(periodo);
  }, [periodo, carregarPrevia]);

  /**
   * Busca o zip autenticado e o entrega ao navegador.
   *
   * O 413 tem tratamento próprio porque a mensagem do servidor traz o NÚMERO
   * medido — quantos documentos, quantos megabytes —, e é esse número que diz
   * a quem lê se o caso é dividir o mês ou se algo está errado. Trocá-lo por
   * "falha ao baixar" jogaria fora a única informação útil da resposta.
   */
  const baixarPacote = async () => {
    if (!previa) return;
    setBaixando(true);
    setMensagem(null);
    setHashDoDownload(null);
    try {
      const arquivo = await apiBinary(
        `/core/fiscal/closings/${previa.period}/pacote`,
        previa.nomeArquivo,
      );
      salvarArquivo(arquivo.blob, arquivo.nomeArquivo);
      /*
        O NÚMERO QUE PROVA O ARQUIVO (GAP-PRD-176). Vem do servidor, que o
        registrou na trilha no mesmo instante. Sem o cabeçalho (servidor
        antigo, proxy que o filtrou), a tela não mostra número nenhum —
        inventar um aqui seria a prova falsa que a conferência existe para
        impedir.
      */
      const sha256 = arquivo.headers?.get(CABECALHO_DO_HASH) ?? null;
      if (sha256) setHashDoDownload({ nomeArquivo: arquivo.nomeArquivo, sha256 });
      setMensagem({
        tom: 'ok',
        texto: `Pacote de ${mesPorExtenso(previa.period)} baixado como ${arquivo.nomeArquivo}. `
          + 'Abra o zip antes de enviar: o LEIA-ME.txt dentro dele diz o que o mês tem e o que '
          + 'não tem.',
      });
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao montar o pacote do mês.',
      });
    } finally {
      setBaixando(false);
    }
  };

  /*
    OS MESES QUE O SELETOR OFERECE.

    A lista da prévia, mais o mês que está aberto quando ele não estiver nela.
    Sem essa união o seletor mostraria um valor que não existe entre as opções
    e o navegador escolheria outro sozinho — a tela passaria a exibir um mês e
    a baixar outro.
  */
  const mesesOferecidos = previa
    ? [...new Set([...previa.mesesComMateriaPrima, periodo])].sort().reverse()
    : [periodo];

  const contagens = previa?.contagens;

  /*
    ESTE SERVIDOR SEPAROU OS TRÊS BALDES?

    Os dois campos nasceram juntos no serviço, então basta um deles ausente para
    a resposta inteira ser da versão antiga. E isso muda o significado de um
    número que já estava na tela: contra o servidor antigo, `recebidasSemArquivo`
    ainda é a soma dos TRÊS fatos — XML perdido, compra sem NF-e e entrada
    estornada —, e o hint que fala em "arquivo não guardado" passa a prometer
    mais do que o balde contém. O hint segue este booleano por isso.
  */
  const servidorSeparouOsBaldes =
    contagens?.recebidasSemNota !== undefined && contagens?.recebidasEstornadas !== undefined;

  const semNada =
    !!contagens
    && contagens.emitidasAutorizadas === 0
    && contagens.emitidasCanceladas === 0
    && contagens.eventos === 0
    && contagens.recebidasComArquivo === 0
    && contagens.recebidasSemArquivo === 0
    /*
      AS DUAS NOVAS ENTRAM NA CONTA DO VAZIO — senão a frase mente.

      Quando `recebidasSemArquivo` deixou de contar a compra sem nota fiscal e
      a entrada estornada, um mês feito só de entradas manuais passou a ter os
      grade inteira em zero. Sem estas duas linhas, a tela diria "este mês não
      tem nota emitida, evento nem nota de entrada" logo acima do cartão de
      pendências listando as compras que ela acabou de negar.

      O `!` em vez de `=== 0` é o que mantém a tela correta contra um servidor
      que ainda não manda os campos: ausente lá é ausente aqui, e não "tem".
    */
    && !contagens.recebidasSemNota
    && !contagens.recebidasEstornadas
    && contagens.faixasInutilizadas === 0;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Fiscal', 'Fechamento do contador']}
        title="Fechamento do contador"
        subtitle="Um arquivo por mês, com o que a empresa emitiu, recebeu e apurou — e com o que ela não tem, escrito por extenso."
        actions={
          <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
            <span className="text-[var(--gs-muted)]">Mês</span>
            <select
              aria-label="Mês do fechamento"
              value={periodo}
              onChange={(e) => {
                setMensagem(null);
                setPeriodo(e.target.value);
              }}
              className="h-9 px-2 rounded-[var(--gs-radius-sm)] border border-[var(--gs-border-strong)]
                bg-[var(--gs-surface)]"
            >
              {mesesOferecidos.map((m) => (
                <option key={m} value={m}>
                  {mesPorExtenso(m)}
                </option>
              ))}
            </select>
          </label>
        }
      />

      {mensagem && (
        <div
          role="status"
          className={`mb-5 px-4 py-3 rounded-[var(--gs-radius)] ${
            mensagem.tom === 'ok'
              ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
              : mensagem.tom === 'info'
                ? 'bg-[var(--gs-info-bg)] text-[var(--gs-info)]'
                : 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
          }`}
        >
          {mensagem.texto}
        </div>
      )}

      {hashDoDownload && (
        <div
          role="note"
          aria-label="SHA-256 do pacote baixado"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-[var(--gs-surface)] text-[length:var(--gs-text-sm)]"
        >
          <p className="m-0">
            SHA-256 de <span className="font-mono">{hashDoDownload.nomeArquivo}</span>:
          </p>
          <p className="mt-1 mb-0 font-mono break-all" data-testid="sha256-do-download">
            {hashDoDownload.sha256}
          </p>
          <p className="mt-1 mb-0 text-[var(--gs-muted)]">
            Este número prova que o arquivo é o que o sistema entregou, e ficou registrado junto
            com quem baixou. Quem receber o zip confere no quadro &quot;Conferir um pacote
            recebido&quot;, no fim desta página.
          </p>
        </div>
      )}

      {carregando && !previa && (
        <Card title="Carregando o mês">
          <p className="m-0 text-[var(--gs-muted)]">Contando o que existe em {mesPorExtenso(periodo)}…</p>
        </Card>
      )}

      {previa && contagens && (
        <>
          <Card
            title={`O que ${mesPorExtenso(previa.period)} tem`}
            subtitle={`${previa.empresa.nome} · de ${previa.primeiroDia} a ${previa.ultimoDia}`}
            className="mb-5"
            actions={
              <Button onClick={() => void baixarPacote()} loading={baixando}>
                Baixar o pacote
              </Button>
            }
          >
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Kpi label="Notas autorizadas" value={String(contagens.emitidasAutorizadas)} />
              <Kpi label="Notas canceladas" value={String(contagens.emitidasCanceladas)} />
              <Kpi
                label="Eventos no mês"
                value={String(contagens.eventos)}
                hint="Cancelamento e carta de correção — pela data em que aconteceram, mesmo que a nota seja de outro mês"
              />
              <Kpi
                label="Compras com XML"
                value={String(contagens.recebidasComArquivo)}
                hint="Entram na pasta recebidas/"
              />
              {/*
                O BALDE DO XML PERDIDO — e a frase que só está certa desde que
                ele ficou sozinho.

                Até o serviço separar `baldeDaEntrada`, esta contagem somava
                três fatos e este hint descrevia um só: quem lia "o arquivo não
                foi guardado e não há como recuperá-lo" sobre um número que
                incluía compras de feira concluía que a loja perdeu documento —
                e ia procurar XML que nunca existiu. Hoje a frase e o balde
                dizem a mesma coisa; contra um servidor antigo, o hint troca e
                declara a mistura, em vez de continuar prometendo.
              */}
              <Kpi
                label="Compras sem XML"
                value={String(contagens.recebidasSemArquivo)}
                tone={contagens.recebidasSemArquivo > 0 ? 'warning' : 'neutral'}
                hint={
                  servidorSeparouOsBaldes
                    ? 'O arquivo do fornecedor não foi guardado e não há como recuperá-lo — '
                      + 'nota anterior a o sistema passar a guardar o XML'
                    : 'Nesta resposta o balde ainda é o antigo: ele pode misturar XML perdido, '
                      + 'compra sem NF-e e entrada estornada'
                }
              />
              {/*
                AS DUAS AUSÊNCIAS QUE FALTAVAM NA GRADE.

                Elas chegavam na prévia e só apareciam três cartões abaixo, no
                "O que falta neste mês". O efeito é o mês de uma loja que compra
                na feira: tudo o que é entrada marcando zero na grade, e a
                resposta fora do alcance da vista — quem passa o olho conclui
                que não houve compra nenhuma.

                NENHUMA DAS DUAS É `warning`, e isso é decisão. Compra sem nota
                fiscal é operação legítima (feira, autônomo, produtor rural) e
                estorno é o sistema funcionando; pintar de amarelo um número que
                acende todo mês numa loja de feira ensina a ignorar o amarelo, e
                aí o "Compras sem XML" — que é perda de verdade — some junto.
              */}
              <Kpi
                label="Compras sem NF-e"
                value={contagemOuNaoSei(contagens.recebidasSemNota)}
                hint={
                  contagens.recebidasSemNota === undefined
                    ? NAO_SEPARADO_POR_ESTE_SERVIDOR
                    : 'Entrada digitada porque o fornecedor não emite nota — feira, autônomo, '
                      + 'produtor rural. Nunca teve XML: não é arquivo perdido'
                }
              />
              <Kpi
                label="Entradas estornadas"
                value={contagemOuNaoSei(contagens.recebidasEstornadas)}
                hint={
                  contagens.recebidasEstornadas === undefined
                    ? NAO_SEPARADO_POR_ESTE_SERVIDOR
                    : 'Entrada confirmada e depois desfeita: o estoque voltou e o título foi '
                      + 'cancelado. Não se escritura como compra; o XML, quando existe, sai em '
                      + 'estornadas/'
                }
              />
              <Kpi
                label="Faixas inutilizadas"
                value={String(contagens.faixasInutilizadas)}
                hint="Só as que a SEFAZ autorizou — pedido e recusa não inutilizam número"
              />
            </div>

            <p className="mt-4 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              O arquivo sairá como <span className="font-mono">{previa.nomeArquivo}</span>. Dentro
              dele: um LEIA-ME dizendo o que o mês tem e o que não tem, um MANIFESTO.csv com uma
              linha por arquivo, e o DRE do período. Pasta sem conteúdo não entra no zip — pasta
              vazia se parece com dado perdido.
            </p>

            {semNada && (
              /*
                O MÊS VAZIO PRECISA SER DITO, e não deduzido de uma grade de zeros.

                Sem esta frase, quem abrisse um mês sem movimento veria um
                painel de zeros e um botão, baixaria um zip com o LEIA-ME e o
                DRE zerado, e concluiria que o sistema falhou. O pacote continua
                disponível de propósito: "não houve movimento" é uma informação
                que o contador precisa receber, não uma ausência de resposta.
              */
              <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)]">
                Este mês não tem nota emitida, evento nem nota de entrada. O pacote sai assim
                mesmo, com o LEIA-ME e o resultado do período — que é o jeito de dizer ao contador
                que não houve movimento, em vez de não dizer nada.
              </p>
            )}
          </Card>

          <Card
            title="O que falta neste mês"
            subtitle="Nada aqui impede o download. São lacunas para quem lê decidir o que fazer — e para o contador não assumir que o mês está completo."
            padded={false}
          >
            {previa.pendencias.length === 0 ? (
              <EmptyState
                title="Nenhuma pendência neste mês"
                description="Tudo o que o sistema tem deste período entra no pacote."
              />
            ) : (
              <ul className="list-none m-0 p-0">
                {previa.pendencias.map((p) => (
                  <li
                    key={p.codigo}
                    className="px-5 py-4 border-b border-[var(--gs-border)] last:border-0"
                  >
                    <p className="m-0 font-semibold text-[var(--gs-purple-900)]">
                      {p.titulo}
                      <span className="ml-2 font-normal text-[var(--gs-muted)]">
                        ({p.quantidade})
                      </span>
                    </p>
                    <p className="mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {p.detalhe}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {souDaGestao && (
            <Card
              title="Envio ao contador por e-mail"
              subtitle="O pacote NUNCA sai direto: cada envio entra na fila de e-mail e o histórico mostra o estado real — pendente, enviado ou falhou."
              className="mt-5"
              actions={
                <Button
                  onClick={() => void enviarPorEmail()}
                  loading={trabalhandoNoEnvio}
                  disabled={destinatarios.filter((d) => d.active).length === 0}
                >
                  Enviar pacote por e-mail
                </Button>
              }
            >
              {envios && envios.carteiro.readiness !== 'READY' && (
                /*
                  O ESTADO HONESTO DO CARTEIRO, antes do primeiro clique: sem
                  SMTP o envio não é "quebrado" nem "enviado" — ele acumula.
                  Esconder isso faria o gerente concluir que mandou e o
                  contador esperar um e-mail que ainda não tem por onde sair.
                */
                <p className="mt-0 mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)] text-[var(--gs-info)] text-[length:var(--gs-text-sm)]">
                  O servidor de e-mail (SMTP) ainda não está configurado. Os envios entram na fila
                  e ficam aguardando — nada se perde; quando a credencial existir, tudo sai.
                </p>
              )}

              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <h4 className="mt-0 mb-2 font-semibold text-[var(--gs-purple-900)]">
                    Quem recebe
                  </h4>
                  {destinatarios.length === 0 ? (
                    <p className="m-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      Nenhum destinatário cadastrado. Sem ao menos um ativo, o envio — manual ou
                      agendado — não tem para onde ir.
                    </p>
                  ) : (
                    <ul className="list-none m-0 mb-3 p-0">
                      {destinatarios.map((d) => (
                        <li
                          key={d.id}
                          className="flex items-center justify-between gap-3 py-2 border-b border-[var(--gs-border)] last:border-0"
                        >
                          <span className={d.active ? '' : 'opacity-50'}>
                            <span className="font-medium">{d.name}</span>{' '}
                            <span className="text-[var(--gs-muted)] font-mono text-[length:var(--gs-text-sm)]">
                              {d.email}
                            </span>
                            {!d.active && (
                              <span className="ml-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                                (inativo)
                              </span>
                            )}
                          </span>
                          <Button variant="ghost" size="sm" onClick={() => void alternarDestinatario(d)}>
                            {d.active ? 'Desativar' : 'Reativar'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label="Nome do destinatário"
                      placeholder="Nome (ex.: Escritório Fagundes)"
                      value={novoNome}
                      onChange={(e) => setNovoNome(e.target.value)}
                      className="h-9 px-2 rounded-[var(--gs-radius-sm)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                    />
                    <input
                      aria-label="E-mail do destinatário"
                      placeholder="email@escritorio.com.br"
                      value={novoEmail}
                      onChange={(e) => setNovoEmail(e.target.value)}
                      className="h-9 px-2 rounded-[var(--gs-radius-sm)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void adicionarDestinatario()}
                      disabled={!novoNome.trim() || !novoEmail.trim() || trabalhandoNoEnvio}
                    >
                      Cadastrar
                    </Button>
                  </div>
                </div>

                <div>
                  <h4 className="mt-0 mb-2 font-semibold text-[var(--gs-purple-900)]">
                    Envio automático
                  </h4>
                  <p className="mt-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    No dia escolhido, o fechamento do MÊS ANTERIOR entra na fila sozinho, para os
                    destinatários ativos — uma vez por competência, mesmo que o servidor passe o
                    dia desligado e ligue depois. Dias 29 a 31 não existem em todo mês, por isso o
                    teto é 28.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
                      <span className="text-[var(--gs-muted)]">Todo dia</span>
                      <select
                        aria-label="Dia do envio automático"
                        value={agendaDia}
                        onChange={(e) => setAgendaDia(Number(e.target.value))}
                        className="h-9 px-2 rounded-[var(--gs-radius-sm)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                      >
                        {Array.from({ length: 28 }, (_, i) => i + 1).map((dia) => (
                          <option key={dia} value={dia}>
                            {dia}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
                      <input
                        type="checkbox"
                        checked={agendaAtiva}
                        onChange={(e) => setAgendaAtiva(e.target.checked)}
                      />
                      Ativo
                    </label>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void salvarAgenda()}
                      loading={trabalhandoNoEnvio}
                    >
                      Salvar agenda
                    </Button>
                  </div>
                  {agenda?.lastSentPeriod && (
                    <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      Última competência enviada pela agenda: {mesPorExtenso(agenda.lastSentPeriod)}.
                    </p>
                  )}
                  {agenda?.lastError && (
                    <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                      Último problema da agenda: {agenda.lastError}
                    </p>
                  )}
                </div>
              </div>

              <h4 className="mt-6 mb-2 font-semibold text-[var(--gs-purple-900)]">
                Envios de {mesPorExtenso(periodo)}
              </h4>
              {!envios || envios.items.length === 0 ? (
                <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Nenhum envio desta competência ainda.
                </p>
              ) : (
                <ul className="list-none m-0 p-0">
                  {envios.items.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-[var(--gs-border)] last:border-0 text-[length:var(--gs-text-sm)]"
                    >
                      <span>
                        <span className="font-medium">{e.name}</span>{' '}
                        <span className="text-[var(--gs-muted)] font-mono">{e.email}</span>{' '}
                        <span className="text-[var(--gs-muted)]">
                          · {e.origem === 'agenda' ? 'automático' : 'manual'} ·{' '}
                          {e.criadoEm.slice(0, 10)}
                        </span>
                      </span>
                      <span
                        className={
                          e.status === 'enviado'
                            ? 'text-[var(--gs-success)]'
                            : e.status === 'falhou'
                              ? 'text-[var(--gs-danger)]'
                              : 'text-[var(--gs-muted)]'
                        }
                      >
                        {ROTULO_DO_STATUS[e.status]}
                        {e.status === 'falhou' && e.erro ? ` — ${e.erro}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
      {/* Para a gestão E para o contador: quem recebe o zip é quem mais precisa conferir. */}
      <ConferirPacoteCard />
    </AppShell>
  );
}
