/**
 * Conciliação: o que o Asaas confirmou × o que o financeiro registrou.
 *
 * A TELA NÃO TEM BOTÃO DE "CORRIGIR", E ISSO É DE PROPÓSITO.
 *
 * Ajustar o lado que parece errado é acertar a balança empurrando o prato:
 * some com o sintoma, mantém a causa, e a próxima divergência já vem em cima
 * de um número adulterado. Aqui se mostra o problema com os dois valores lado
 * a lado; quem decide o que fazer é quem responde pelo caixa.
 *
 * Cada divergência é dinheiro real:
 *
 *   COBRADO E NÃO LANÇADO   entrou na conta do Asaas e não existe no
 *                           financeiro — some do faturamento e do imposto.
 *   LANÇADO E NÃO COBRADO   o financeiro diz que recebeu e o provedor não tem
 *                           a cobrança — infla o resultado.
 *   VALOR DIVERGENTE        os dois existem e não batem.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';
import { AppShell } from '@/components/gs/AppShell';
import { formatCents } from '@/components/gs/format';
import { dataBR, diasAtras } from '@/lib/datas';
import { destinoDaOrigem } from '@/lib/rotasDeOrigem';
import { SincronizacaoAsaasCard, type ResumoDaSincronizacao } from '@/components/gs/SincronizacaoAsaasCard';

/**
 * ============================================================================
 * DE QUE PAPEL É ESTA DIVERGÊNCIA — e por que ela dizia `finance_entry`
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * A linha da divergência imprimia `originType` CRU: o gerente que confere
 * dinheiro lia "finance_entry · 0d642d4a-3f11-…" — o nome da COLUNA do banco e
 * um UUID —, sem rótulo humano e sem porta para o documento. É a MESMA
 * informação que o contas a receber já mostra traduzida e clicável
 * (`originLabel`, vindo do servidor, mais `destinoDaOrigem`), e é justamente a
 * divergência que este relatório existe para explicar: quem lê precisa saber
 * de que papel se trata e chegar nele para investigar. Escrita em vocabulário
 * de banco de dados, a linha é a que ninguém investiga.
 *
 * ## POR QUE UM `Record` TOTAL, E NÃO UM `switch` COM `default`
 *
 * Lista escrita à mão é bomba armada: uma quinta origem de cobrança nascida no
 * servidor voltaria a imprimir nome de coluna aqui, EM SILÊNCIO. O `Record`
 * sobre a união quebra a COMPILAÇÃO quando falta um rótulo — e o teste desta
 * tela costura a união com o `PaymentOriginType` do servidor, porque o frontend
 * não importa código de `server/` e a cópia à mão poderia envelhecer sozinha.
 *
 * ## LINK SÓ ONDE HÁ PORTA
 *
 * `destinoDaOrigem` é o MESMO tradutor do contas a receber — não um segundo
 * mapa de rotas escrito aqui. Ele devolve `null` para o que não tem tela, e o
 * `finance_entry` é um desses: o contas a receber não abre por id de
 * lançamento. Aí a linha ganha o NOME e não ganha link — porta desenhada que
 * não abre é pior que porta nenhuma.
 */
type OrigemDaCobranca = 'ecommerce_order' | 'sale' | 'service_order' | 'finance_entry';

const ROTULO_DA_ORIGEM: Record<OrigemDaCobranca, string> = {
  ecommerce_order: 'Pedido da loja online',
  sale: 'Venda',
  service_order: 'Ordem de serviço',
  // O contas a receber cobrado por PIX/boleto/link: a cobrança aponta para o
  // PRÓPRIO título, e o `originId` é o id do lançamento — não de um documento.
  finance_entry: 'Título do contas a receber',
};

interface Linha {
  kind: 'cobrado_nao_lancado' | 'lancado_nao_cobrado' | 'valor_divergente';
  /**
   * O tipo vem do servidor como texto: `string` e não `OrigemDaCobranca`, de
   * propósito. Estreitar aqui faria o compilador AFIRMAR que a resposta só
   * traz as quatro conhecidas — e no dia em que trouxer uma quinta, a tela
   * indexaria o Record e escreveria `undefined` na cara de quem confere
   * dinheiro. A leitura abaixo trata o desconhecido explicitamente.
   */
  originType: string;
  originId: string;
  providerCents: number | null;
  financeCents: number | null;
  differenceCents: number;
  providerRef: string | null;
  confirmedAt: string | null;
  description: string;
}

interface Relatorio {
  from: string;
  to: string;
  providerCents: number;
  financeCents: number;
  differenceCents: number;
  matched: number;
  rows: Linha[];
  /**
   * A última consulta ao provedor e quantas cobranças esperam uma (GAP-PRD-016).
   * Opcional: servidor antigo não manda, e a tela não pode quebrar por isso.
   */
  sincronizacao?: ResumoDaSincronizacao;
}

const EXPLICACAO: Record<Linha['kind'], { titulo: string; oQueSignifica: string }> = {
  cobrado_nao_lancado: {
    titulo: 'Cobrado e não lançado',
    oQueSignifica:
      'O dinheiro entrou na conta do provedor e não existe no financeiro. Confira o webhook '
      + 'da operação antes de lançar à mão — lançar sem descobrir a causa faz o problema voltar.',
  },
  lancado_nao_cobrado: {
    titulo: 'Lançado e não cobrado',
    oQueSignifica:
      'O financeiro registrou um recebimento que o provedor não confirmou. É receita que pode '
      + 'não existir: confirme no extrato do provedor antes de considerar no resultado.',
  },
  valor_divergente: {
    titulo: 'Valor divergente',
    oQueSignifica:
      'Os dois lados existem e não batem. Centavos costumam ser arredondamento; valores '
      + 'maiores indicam cobrança alterada depois de criada.',
  },
};

/** O dia da loja, e não o de Greenwich: depois das 21h eram dias diferentes. */
const hojeMenos = diasAtras;

/**
 * ============================================================================
 * NÚMERO NA TELA É SEMPRE DE UM RECORTE — e do recorte que o produziu
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * O `catch` do `carregar()` só escrevia `setErro(...)` e NÃO limpava `dados`.
 * Quem carregava 30 dias, via os cartões "No provedor / No financeiro /
 * Diferença" e a frase "Tudo confere: N recebimento(s)", depois invertia as
 * datas e recebia a recusa do servidor, continuava com AQUELES cartões
 * desenhados logo abaixo do alerta vermelho — números reais de um período que
 * não é o dos campos. Trocar o vazio tranquilizador por "os números de outro
 * período ao lado do erro" é trocar um engano por outro, e este é pior: são
 * valores de dinheiro que parecem a resposta ao que se acabou de pedir.
 *
 * E a tela não imprimia em lugar nenhum o `from`/`to` que o relatório devolveu
 * — então não havia como perceber a troca olhando.
 *
 * ## A REGRA
 *
 * Recusa APAGA os números: não se mostra meia resposta. E enquanto houver
 * números na tela, ela escreve de que período eles são — o período que o
 * SERVIDOR usou (`from`/`to` do relatório), que é o único que responde pelos
 * valores, inclusive quando o gerente limpa uma ponta e o servidor completa.
 */
export default function ConciliacaoAsaasPage() {
  const [de, setDe] = useState(hojeMenos(30));
  const [ate, setAte] = useState(hojeMenos(0));
  const [dados, setDados] = useState<Relatorio | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setOcupado(true);
    setErro(null);
    try {
      setDados(
        await apiRequest<Relatorio>(
          `/core/asaas/conciliacao?from=${encodeURIComponent(de)}&to=${encodeURIComponent(ate)}`,
        ).then((r) => exigirCampos(r, 'from', 'to', 'providerCents', 'financeCents', 'differenceCents', 'matched', 'rows')),
      );
    } catch (err) {
      // A recusa APAGA os números: alerta vermelho em cima dos cartões do
      // período anterior é a tela respondendo uma pergunta que ninguém fez.
      setDados(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível conciliar.');
    } finally {
      setOcupado(false);
    }
  }, [de, ate]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <AppShell>
      <div className="p-6">
        <h1 className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] mt-0 mb-1">
          Conciliação de recebimentos
        </h1>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-6">
          Compara o que o provedor confirmou com o que o financeiro registrou. Esta tela não
          ajusta nenhum dos dois lados para bater — ela mostra a diferença para você decidir. A
          consulta ao provedor só traz para o ERP o que o provedor diz de cada cobrança em aberto,
          pelo mesmo caminho do aviso automático (webhook).
        </p>

        <div className="flex flex-wrap items-end gap-3 mb-6">
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">De</span>
            <input
              type="date"
              value={de}
              aria-label="Data inicial"
              onChange={(e) => setDe(e.target.value)}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">Até</span>
            <input
              type="date"
              value={ate}
              aria-label="Data final"
              onChange={(e) => setAte(e.target.value)}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            />
          </label>
          <button
            type="button"
            onClick={() => void carregar()}
            disabled={ocupado}
            className="bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white border-0
              rounded-[var(--gs-radius)] px-4 py-2 font-semibold cursor-pointer disabled:opacity-50"
          >
            {ocupado ? 'Conferindo…' : 'Conferir'}
          </button>
        </div>

        {erro && (
          <p role="alert" className="text-[var(--gs-danger)] mb-4">
            {erro}
          </p>
        )}

        {dados && <SincronizacaoAsaasCard resumo={dados.sincronizacao} onConsultou={carregar} />}

        {dados && (
          <>
            {/*
              DE QUE PERÍODO SÃO ESTES NÚMEROS — e do período que o SERVIDOR
              usou, não do que está escrito nos campos. São coisas diferentes
              quando o gerente limpa uma ponta (o servidor completa com hoje e
              com 30 dias atrás) e quando ele mexe nas datas sem apertar
              "Conferir". Sem esta linha, os cartões são valores de dinheiro
              sem recorte nenhum.
            */}
            <p
              role="status"
              className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-3"
            >
              Números do período conferido: {dataBR(dados.from)} a {dataBR(dados.to)}.
            </p>

            <div className="grid gap-3 sm:grid-cols-3 mb-6">
              <Cartao titulo="No provedor" valor={formatCents(dados.providerCents)} />
              <Cartao titulo="No financeiro" valor={formatCents(dados.financeCents)} />
              <Cartao
                titulo="Diferença"
                valor={formatCents(dados.differenceCents)}
                alerta={dados.differenceCents !== 0}
              />
            </div>

            {dados.rows.length === 0 ? (
              <p
                role="status"
                className={
                  dados.matched > 0 ? 'text-[var(--gs-success)]' : 'text-[var(--gs-muted)]'
                }
              >
                {/*
                  Nada comparado NÃO é "tudo certo". Dizer que confere quando
                  não havia o que conferir dá uma garantia que ninguém checou —
                  e é justamente no período sem movimento que a pessoa precisa
                  saber que o problema pode ser a busca, não o caixa.
                */}
                {dados.matched > 0
                  ? `Tudo confere: ${dados.matched} recebimento(s) batendo nos dois lados.`
                  : 'Nenhum recebimento do provedor neste período — não houve o que conferir.'}
              </p>
            ) : (
              <ul className="list-none p-0 m-0 flex flex-col gap-3">
                {dados.rows.map((l) => (
                  <li
                    key={`${l.originType}-${l.originId}-${l.kind}`}
                    className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
                      rounded-[var(--gs-radius)] p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-[var(--gs-danger)]">
                        {EXPLICACAO[l.kind].titulo}
                      </strong>
                      <span className="font-mono text-[length:var(--gs-text-sm)]">
                        {formatCents(Math.abs(l.differenceCents))}
                      </span>
                    </div>

                    <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {EXPLICACAO[l.kind].oQueSignifica}
                    </p>

                    {/* Os dois números lado a lado: sem isso, quem investiga
                        não sabe qual lado conferir primeiro. */}
                    <p className="m-0 mt-2 text-[length:var(--gs-text-sm)]">
                      Provedor:{' '}
                      <strong>
                        {l.providerCents === null ? 'sem cobrança' : formatCents(l.providerCents)}
                      </strong>
                      {' · '}
                      Financeiro:{' '}
                      <strong>
                        {l.financeCents === null ? 'sem lançamento' : formatCents(l.financeCents)}
                      </strong>
                    </p>

                    {/*
                      DE QUE PAPEL É ESTA DIVERGÊNCIA.

                      Antes: `finance_entry · 0d642d4a-…` — nome de coluna e
                      UUID, para quem confere dinheiro. Agora: o nome em
                      português e, quando existe tela, o caminho até o
                      documento. O ID FICA: traduzir não é esconder, e é por
                      ele que o suporte casa a linha com o extrato do provedor.
                    */}
                    <p className="m-0 mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                      <OrigemDaLinha originType={l.originType} originId={l.originId} />
                      {' · '}
                      <span className="font-mono">{l.originId}</span>
                      {l.providerRef && (
                        <>
                          {' · '}
                          <span className="font-mono">{l.providerRef}</span>
                        </>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

/**
 * O nome do documento da divergência — e a porta para ele, quando existe.
 *
 * TRÊS DESFECHOS, e os três são honestos:
 *
 *   1. origem conhecida COM tela  → nome em português, dentro de um link que
 *      abre o documento (o mesmo `destinoDaOrigem` do contas a receber);
 *   2. origem conhecida SEM tela  → só o nome. O `finance_entry` é este caso:
 *      não existe tela que abra um lançamento por id, e link para ela seria
 *      porta desenhada que não abre;
 *   3. origem DESCONHECIDA        → o código cru, como antes. Inventar
 *      "Documento" daria nome de gente a uma coisa que a tela não sabe o que
 *      é, e o gerente confiaria num rótulo que ninguém escreveu. Feio e
 *      honesto ganha de bonito e errado — e o teste de costura com o
 *      `PaymentOriginType` do servidor existe para que este caso nunca chegue
 *      a acontecer em produção.
 */
function OrigemDaLinha({ originType, originId }: { originType: string; originId: string }) {
  const rotulo = ROTULO_DA_ORIGEM[originType as OrigemDaCobranca] as string | undefined;
  if (!rotulo) return <>{originType}</>;

  const destino = destinoDaOrigem(originType, originId);
  if (!destino) return <>{rotulo}</>;

  return (
    <Link to={destino} className="text-[var(--gs-purple-700)] underline">
      {rotulo}
    </Link>
  );
}

function Cartao({
  titulo,
  valor,
  alerta,
}: {
  titulo: string;
  valor: string;
  alerta?: boolean;
}) {
  return (
    <div
      className={`bg-[var(--gs-surface)] border rounded-[var(--gs-radius-lg)] p-4 ${
        alerta ? 'border-[var(--gs-danger)]' : 'border-[var(--gs-border)]'
      }`}
    >
      <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">{titulo}</span>
      <strong
        className={`text-[length:var(--gs-text-xl)] ${alerta ? 'text-[var(--gs-danger)]' : ''}`}
      >
        {valor}
      </strong>
    </div>
  );
}
