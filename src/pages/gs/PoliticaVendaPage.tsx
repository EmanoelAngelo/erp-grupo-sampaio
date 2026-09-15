/**
 * Configurações › Política do balcão.
 *
 * ## O que esta tela resolve
 *
 * Três números decidiam sozinhos o dia a dia de quem está no caixa, e os três
 * estavam cravados onde o dono não alcança: o limite de desconto era uma
 * constante no servidor, a venda a prazo nascia vencendo no mesmo dia, e a
 * validade da pré-venda existia só como um `7` digitado no formulário de
 * orçamento. Mudar qualquer um deles era tarefa de quem edita código.
 *
 * ## CAMPO VAZIO NÃO É ZERO, e é isto que a tela precisa deixar óbvio
 *
 * Vazio significa "o comportamento de hoje" — o padrão do sistema. Zero é uma
 * decisão, e nos três campos é uma decisão FORTE e diferente: limite zero é
 * "nenhuma concessão sem gestor"; prazo zero é "fiado vence hoje"; validade
 * zero é "a reserva morre no fim do dia".
 *
 * Por isso o campo não configurado aparece EM BRANCO, e não preenchido com o
 * padrão. Um campo mostrando "10" não distingue "eu escolhi 10" de "ninguém
 * configurou". O dono jurando que configurou 5% enquanto o balcão dá 10% é o
 * sintoma exato que essa distinção evita — e é o `definidos` que o servidor
 * devolve que permite mostrá-la, em vez de a tela adivinhar.
 *
 * ## O QUARTO CAMPO QUEBRA A REGRA DE CIMA, e por isso é falado à parte
 *
 * O teto da sangria não tem padrão de sistema. Nos três primeiros, vazio herda
 * um número que alguém escolheu um dia; no quarto, vazio é AUSÊNCIA DE TRAVA —
 * o operador retira da gaveta o que quiser, até zerar. A analogia com os campos
 * de cima é justamente a leitura errada: o dono veria o quarto campo em branco
 * e suporia um limite que não existe.
 *
 * Um campo em branco calado não conta essa diferença, então a tela a escreve:
 * o rótulo, a dica e a linha "Vale hoje" dizem SEM TETO com todas as letras, e
 * a etiqueta ao lado é de aviso, e não de "padrão do sistema".
 *
 * ## Quem entra aqui
 *
 * A rota é ROTA_GESTAO, que abre também para estoquista e atendente. O
 * servidor é mais estreito de propósito — só gerente_loja, gerente_oficina e,
 * por cima de tudo, admin_geral/gestor —, porque quem pode editar o próprio
 * limite de desconto não tem limite nenhum. Quando ele recusa, esta tela diz
 * QUE FOI RECUSA DE PERMISSÃO, e não "falha ao carregar": tela que mostra erro
 * genérico para permissão negada faz a pessoa chamar suporte por um sistema
 * que está funcionando exatamente como deveria.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, Field, Input, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type PoliticaDeVenda } from '@/lib/api/core';

/**
 * O que viaja no fio: o TEXTO, aparado nas pontas. Nada é convertido aqui.
 *
 * ## O erro de digitação que AUMENTAVA o limite
 *
 * Esta função convertia, e devolvia `Number.NaN` para o que não era número —
 * de propósito, para o servidor recusar, porque converter para zero abriria o
 * balcão inteiro em cima de um erro de digitação. A intenção estava certa e o
 * FORMATO DO FIO a derrubou: NaN não existe em JSON, e `JSON.stringify({a:
 * NaN})` produz `{"a":null}`. Nulo, do outro lado, significa exatamente a
 * decisão oposta à recusa — "volta ao padrão do sistema".
 *
 * O resultado era o pior modo de falha possível: o dono digitava "dez" no
 * lugar de 10, a gravação era ACEITA, e o limite de desconto voltava para os
 * 10% do sistema em vez de ser recusado. Uma trava que falha ABERTA em cima de
 * um erro de digitação é a coisa que esta rodada inteira existe para evitar.
 *
 * ## Por que o texto cru resolve, e a validação na tela não
 *
 * Porque os três estados precisam ser DISTINGUÍVEIS do outro lado, e só o
 * texto os mantém separados: `''` é campo apagado (volta ao padrão), `'0'` é
 * decisão legítima e oposta (nenhuma concessão sem gestor), `'dez'` é erro.
 * Qualquer conversão aqui tem de escolher um número para representar o erro —
 * e todo número que ela escolher é um valor válido para alguém.
 *
 * Quem tem a régua é o servidor: é ele que sabe que percentual vai de 0 a 100,
 * que dia é inteiro e que prazo tem teto — e é a mensagem DELE, com o nome do
 * campo, que a pessoa lê. Repetir essa régua aqui criaria duas verdades sobre
 * o mesmo número, que divergem na primeira vez que uma das duas mudar.
 */
function paraOServidor(texto: string): string {
  return texto.trim();
}

/**
 * O valor do campo depois de carregar.
 *
 * Vazio quando ninguém escolheu. Nunca o padrão: ver o cabeçalho.
 */
function paraOCampo(valor: number, definido: boolean): string {
  return definido ? String(valor) : '';
}

/**
 * O teto da sangria, de CENTAVOS (como o servidor guarda) para REAIS (como o
 * dono digita).
 *
 * ## Por que este campo tem função própria, e os outros três não
 *
 * Porque ele muda de unidade no caminho, e porque a ausência dele significa
 * outra coisa. Nos outros três, nulo nunca chega: o servidor já resolveu cada
 * número contra o padrão do sistema, e `definidos` só diz de onde veio. Aqui
 * NÃO HÁ padrão para resolver — nulo é o valor final, e quer dizer "sem teto".
 *
 * O campo fica vazio nos dois casos, e é de propósito: vazio na tela e nulo no
 * banco são a MESMA decisão, que é a de não travar a gaveta. É a frase ao lado
 * do campo que carrega o significado, porque um campo em branco sozinho não
 * distingue "não há teto" de "ninguém preencheu ainda" — e essa confusão é
 * exatamente a que faz o dono achar que existe um limite que ele não vê.
 *
 * A vírgula é a do teclado brasileiro: R$ 500,00 sai "500,00" e volta ao
 * servidor assim, que é quem troca por ponto em `numeroOuPadrao`. Normalizar
 * aqui criaria a segunda régua sobre o mesmo número.
 */
function tetoParaOCampo(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Há teto configurado, na resposta que chegou?
 *
 * O tipo diz `number | null`, e o servidor de hoje sempre manda o campo. Este
 * `undefined` é sobre o servidor de ONTEM: durante um deploy, a tela nova
 * conversa alguns minutos com a API antiga, que responde a política sem esta
 * chave. `politica.cashWithdrawalLimitCents === null` daria FALSO para
 * `undefined`, e a tela renderizaria "undefined por sangria" como se fosse o
 * limite vigente — um valor inventado no lugar da ausência de trava, que é o
 * modo de errar mais caro que este campo tem.
 *
 * Ausência de resposta e ausência de teto levam ao mesmo texto de propósito:
 * "sem teto" é o que a tela SABE nos dois casos, e é a leitura conservadora —
 * ela avisa que a gaveta pode não estar protegida em vez de garantir que está.
 */
function temTeto(cents: number | null | undefined): cents is number {
  return typeof cents === 'number';
}

/**
 * O nome de cada perfil que aceita limite próprio (P0 da Preço Justo) — o
 * mesmo vocabulário da tela de Equipe. A LISTA vem do servidor
 * (`perfisComLimite`); aqui mora só o rótulo, e perfil sem rótulo aparece com
 * o código em vez de sumir.
 */
const ROTULO_DO_PERFIL: Record<string, string> = {
  operador_caixa_loja: 'Operador de caixa (loja)',
  operador_caixa_oficina: 'Caixa da oficina',
  operador_caixa: 'Operador de caixa',
  atendente: 'Atendente',
  estoquista: 'Estoquista',
  mecanico: 'Mecânico / técnico',
  gerente_loja: 'Gerente de loja',
  gerente_oficina: 'Gerente de oficina',
  gerente_operacao_loja: 'Gerente de operação',
  gestor: 'Gestor',
};

/**
 * Quem tem alçada: para eles o % da venda em branco é SEM TETO — para os
 * outros, é o limite de cima. É o espelho de `AUTHORIZERS` do servidor, só
 * para a dica do campo; quem decide é o servidor.
 */
const PERFIS_COM_ALCADA = new Set(['gerente_loja', 'gerente_oficina', 'gestor']);

type CampoDoLimite = 'maxPercent' | 'maxReais' | 'itemMaxPercent' | 'itemMaxReais';

const ROTULO_DO_CAMPO: Record<CampoDoLimite, string> = {
  maxPercent: 'desconto da venda (%)',
  maxReais: 'desconto da venda (R$)',
  itemMaxPercent: 'desconto por item (%)',
  itemMaxReais: 'desconto por item (R$)',
};

/** Uma linha da tabela de limites, em TEXTO — como os outros campos da tela. */
interface LinhaDeLimite {
  profileCode: string;
  maxPercent: string;
  maxReais: string;
  itemMaxPercent: string;
  itemMaxReais: string;
}

/**
 * As linhas da tabela: um perfil por linha, na ordem do servidor, com o que
 * está gravado — e vazio onde não há teto. Percentual como número cru ("7.5"),
 * valor em reais no formato brasileiro, como o teto da sangria.
 */
function linhasDeLimite(p: PoliticaDeVenda): LinhaDeLimite[] {
  const porPerfil = new Map((p.limitesPorPerfil ?? []).map((l) => [l.profileCode, l]));
  return (p.perfisComLimite ?? []).map((perfil) => {
    const l = porPerfil.get(perfil);
    return {
      profileCode: perfil,
      maxPercent: l?.maxPercent == null ? '' : String(l.maxPercent),
      maxReais: tetoParaOCampo(l?.maxCents),
      itemMaxPercent: l?.itemMaxPercent == null ? '' : String(l.itemMaxPercent),
      itemMaxReais: tetoParaOCampo(l?.itemMaxCents),
    };
  });
}

/** Um número da política, com o rótulo que diz de onde ele veio. */
function ValorVigente({
  valor,
  definido,
  sufixo,
}: {
  valor: string;
  definido: boolean;
  sufixo: string;
}) {
  return (
    <span className="flex items-center gap-2 flex-wrap">
      <strong className="text-[var(--gs-purple-900)]">
        {valor} {sufixo}
      </strong>
      {definido ? (
        <Badge tone="info">definido por você</Badge>
      ) : (
        <Badge tone="neutral">padrão do sistema</Badge>
      )}
    </span>
  );
}

export default function PoliticaVendaPage() {
  const [politica, setPolitica] = useState<PoliticaDeVenda | null>(null);
  const [limite, setLimite] = useState('');
  const [prazo, setPrazo] = useState('');
  const [validade, setValidade] = useState('');
  /** Teto da sangria, em REAIS e como texto. Vazio = sem teto. */
  const [tetoSangria, setTetoSangria] = useState('');
  /** Faturar OS a prazo (GAP-PRD-104). Desmarcado é o padrão seguro. */
  const [faturaOs, setFaturaOs] = useState(false);
  /** Exigir motivo na liberação de desconto (P0 da Preço Justo). */
  const [motivoObrigatorio, setMotivoObrigatorio] = useState(false);
  /** Os limites por perfil, em texto, uma linha por perfil (P0). */
  const [limites, setLimites] = useState<LinhaDeLimite[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  /**
   * Recusa de PERMISSÃO é estado próprio, e não uma mensagem de erro qualquer.
   *
   * Ela não some ao tentar de novo, não é falha de rede e não tem nada a ver
   * com o que a pessoa digitou — o formulário inteiro deixa de fazer sentido.
   */
  const [semPermissao, setSemPermissao] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [carregando, setCarregando] = useState(true);

  const aplicar = useCallback((p: PoliticaDeVenda) => {
    setPolitica(p);
    setLimite(paraOCampo(p.discountLimitPercent, p.definidos.discountLimitPercent));
    setPrazo(paraOCampo(p.creditSaleDueDays, p.definidos.creditSaleDueDays));
    setValidade(paraOCampo(p.reservationValidDays, p.definidos.reservationValidDays));
    setTetoSangria(tetoParaOCampo(p.cashWithdrawalLimitCents));
    // Servidor anterior ao campo não o devolve: lê como desligado, o padrão.
    setFaturaOs(p.workshopCreditEnabled === true);
    setMotivoObrigatorio(p.discountReasonRequired === true);
    setLimites(linhasDeLimite(p));
  }, []);

  const mudarLimite = useCallback((perfil: string, campo: CampoDoLimite, valor: string) => {
    setLimites((ls) => ls.map((l) => (l.profileCode === perfil ? { ...l, [campo]: valor } : l)));
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setErro(null);
      aplicar(await coreApi.getSalePolicy());
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) {
        setSemPermissao(true);
      } else {
        setErro(
          err instanceof ApiRequestError ? err.message : 'Falha ao carregar a política.',
        );
      }
    } finally {
      setCarregando(false);
    }
  }, [aplicar]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const tetoPedido = paraOServidor(tetoSangria);
      /*
        Os dois campos do P0 só viajam para o servidor que os conhece — o que
        devolveu `perfisComLimite`. Durante um deploy a tela nova conversa com a
        API antiga, e mandar uma lista vazia de limites para quem não sabe o
        que ela é não faria mal; mandar para quem SABE, sem ter lido o que está
        gravado, apagaria os limites de todo mundo.
      */
      const servidorConheceLimites = Array.isArray(politica?.perfisComLimite);
      const p = await coreApi.saveSalePolicy({
        discountLimitPercent: paraOServidor(limite),
        creditSaleDueDays: paraOServidor(prazo),
        reservationValidDays: paraOServidor(validade),
        cashWithdrawalLimitReais: tetoPedido,
        workshopCreditEnabled: faturaOs,
        ...(servidorConheceLimites
          ? {
              discountReasonRequired: motivoObrigatorio,
              limitesPorPerfil: limites.map((l) => ({
                profileCode: l.profileCode,
                maxPercent: paraOServidor(l.maxPercent),
                maxReais: paraOServidor(l.maxReais),
                itemMaxPercent: paraOServidor(l.itemMaxPercent),
                itemMaxReais: paraOServidor(l.itemMaxReais),
              })),
            }
          : {}),
      });
      aplicar(p);
      // O aviso repete o que FICOU VALENDO, lido da resposta e não do que foi
      // digitado: se a gravação divergir um dia, a tela denuncia na hora.
      setAviso(
        `Pronto. O balcão concede até ${p.discountLimitPercent}% sem gestor, `
          + `a venda a prazo vence em ${p.creditSaleDueDays} dia(s), a pré-venda `
          + `segura o estoque por ${p.reservationValidDays} dia(s) e `
          + (temTeto(p.cashWithdrawalLimitCents)
            ? `a sangria vai até ${formatCents(p.cashWithdrawalLimitCents)} sem gestor.`
            : 'a sangria não tem teto.')
          + (p.workshopCreditEnabled ? ' A OS da oficina pode ser faturada a prazo.' : ''),
      );
      /*
        O DIA EM QUE A GRAVAÇÃO DIVERGIR, A TELA DENUNCIA — e este campo é o
        primeiro a precisar disso de verdade.

        `aplicar(p)` relê a resposta, então um teto que não foi gravado some do
        campo na frente do dono. Some em SILÊNCIO, porém: ele digita 500, salva,
        vê o campo vazio e conclui que errou a digitação. A frase abaixo é a
        diferença entre "some" e "some dizendo por quê".

        Não é hipótese. Hoje `PUT /core/sale-policies` monta a chamada a
        `salvarPolitica` com três campos nomeados um a um e NÃO repassa
        `cashWithdrawalLimitReais` — o serviço aceita o parâmetro, a rota não o
        entrega. O teto viaja no fio, é ignorado, e a coluna é gravada como
        nula. Enquanto a rota não passar o campo, esta é a única testemunha que
        o dono tem de que a decisão dele não foi guardada.

        A comparação é sobre PRESENÇA, e não sobre o valor: converter reais para
        centavos aqui para conferir o número recriaria no frontend a régua que
        mora no servidor. Pediu teto e voltou sem teto é tudo o que precisa ser
        detectado — e é o único desfecho que este defeito produz.
      */
      if (tetoPedido !== '' && p.cashWithdrawalLimitCents === null) {
        setErro(
          'O teto da sangria NÃO foi gravado: o servidor respondeu "sem teto" para o valor '
            + `que você digitou (${tetoPedido}). Os outros campos foram salvos. Nada trava a `
            + 'gaveta até isso ser corrigido — não confie neste limite ainda.',
        );
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) {
        setSemPermissao(true);
      } else {
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
      }
    } finally {
      setSalvando(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Política do balcão']}
        title="Política do balcão"
        subtitle="O que o caixa pode fazer sem chamar você."
      />

      {semPermissao && (
        <Card title="Esta decisão não é do balcão">
          <p role="alert" className="m-0">
            Seu perfil não edita a política comercial desta operação. O limite de desconto existe
            justamente para limitar quem está no caixa — quem pode mudar o próprio limite não tem
            limite nenhum. Peça a um gerente ou ao responsável pela operação.
          </p>
        </Card>
      )}

      {erro && (
        <Card>
          <p role="alert" className="m-0">
            {erro}
          </p>
        </Card>
      )}
      {aviso && (
        <Card>
          <p className="m-0">{aviso}</p>
        </Card>
      )}

      {/*
        O subtítulo do card abaixo ganhou a exceção, e ela não é detalhe.

        Ele dizia só "campo em branco é o padrão do sistema", o que era verdade
        quando havia três campos. Com o teto da sangria embaixo, a mesma frase
        passou a AFIRMAR o que a tela precisa negar: que o quarto campo vazio
        também herda um número. É o cabeçalho do card que a pessoa lê antes dos
        campos — deixá-lo desatualizado seria a tela desmentindo a si mesma de
        cima para baixo.
      */}
      {!semPermissao && (
        <Card
          title="O que vale hoje"
          subtitle="Campo em branco é o padrão do sistema — não é zero, e não é 'desligado'. A exceção é o teto da sangria, no fim: lá, em branco significa SEM TETO."
        >
          {carregando && <p className="m-0 text-[var(--gs-muted)]">Carregando…</p>}
          {politica && (
            <div className="flex flex-col gap-5">
              <Field
                label="Desconto que o caixa dá sem chamar gestor (%)"
                hint="Em branco = 10%, como o sistema sempre fez. Zero é diferente de vazio: significa que NENHUMA concessão passa sem liberação."
              >
                {(p) => (
                  <Input
                    {...p}
                    value={limite}
                    placeholder="10 (padrão do sistema)"
                    inputMode="decimal"
                    onChange={(e) => setLimite(e.target.value)}
                  />
                )}
              </Field>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Vale hoje:{' '}
                <ValorVigente
                  valor={String(politica.discountLimitPercent)}
                  definido={politica.definidos.discountLimitPercent}
                  sufixo="%"
                />
              </p>
              {/*
                A conta é sobre a CONCESSÃO inteira, e não sobre o campo de
                desconto. Sem esta frase o dono configura 5% achando que está
                limitando o rodapé, e não entende por que o PDV pede gestor numa
                venda em que ninguém digitou desconto — a diferença veio do preço
                unitário rebaixado, que nunca passava por alçada nenhuma.
              */}
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                O limite mede tudo o que a loja deixa de cobrar numa venda: o desconto do rodapé,
                o desconto digitado nas linhas e o preço unitário abaixo do vigente. O PDV mostra a
                soma e de onde ela veio antes de fechar.
              </p>

              <Field
                label="Prazo da venda a prazo (dias)"
                hint="Em branco = 0, que é o comportamento de hoje: a dívida do fiado nasce vencendo no mesmo dia da venda."
              >
                {(p) => (
                  <Input
                    {...p}
                    value={prazo}
                    placeholder="0 (padrão do sistema)"
                    inputMode="numeric"
                    onChange={(e) => setPrazo(e.target.value)}
                  />
                )}
              </Field>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Vale hoje:{' '}
                <ValorVigente
                  valor={String(politica.creditSaleDueDays)}
                  definido={politica.definidos.creditSaleDueDays}
                  sufixo="dia(s)"
                />
              </p>
              {/*
                O AVISO QUE FALTAVA, e ele é sobre honestidade da tela.

                Este campo tem leitor no servidor — `SalesService` usa o prazo
                para datar o "a receber" da venda SEM nenhum pagamento na hora,
                que é o que fiado significa. O que ele ainda não tem é CAMINHO
                DE TELA: o PDV só finaliza com o pagamento coberto, então hoje
                não existe, pelo navegador, venda que chegue com a lista de
                pagamentos vazia.

                Calar isso seria repetir de trás para frente o defeito que esta
                tela veio consertar: em vez de campo gravado que ninguém lê,
                campo lido que nada aciona — e o dono configurando 30 dias,
                conferindo o painel financeiro e não entendendo por que nada
                mudou. A frase está na tela, e não só num comentário, porque
                quem precisa dela é ele.
              */}
              {/*
                O CAMINHO DE TELA CHEGOU — pela oficina, e só por ela (GAP-PRD-104).

                O aviso acima dizia que nenhuma venda chegava sem pagamento pelo
                navegador. Agora uma chega: a OS faturada para o cliente, no
                recebimento da oficina, quando esta caixa estiver marcada. O PDV
                da loja continua fechando só com o total coberto — a frase diz
                as duas coisas, porque o dono precisa saber onde o prazo vale.
              */}
              <label className="flex items-start gap-2 text-[length:var(--gs-text-sm)]">
                <input
                  type="checkbox"
                  aria-label="Faturar OS a prazo"
                  checked={faturaOs}
                  onChange={(e) => setFaturaOs(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  <strong>Faturar OS a prazo.</strong> O caixa da oficina pode fechar a OS sem
                  pagamento na hora, como conta a receber do cliente do cadastro, vencendo no prazo
                  acima. Desmarcado (o padrão), a OS só fecha com o total coberto.
                </span>
              </label>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Onde este prazo vale: na OS faturada a prazo pela oficina, quando a caixa acima
                está marcada. O PDV da loja continua fechando só com o total coberto — no balcão da
                loja, nada no financeiro muda por causa dele.
              </p>

              <Field
                label="Validade da pré-venda (dias)"
                hint="Em branco = 7 dias. A pré-venda RESERVA estoque: enquanto ela vale, a peça não aparece como disponível para mais ninguém."
              >
                {(p) => (
                  <Input
                    {...p}
                    value={validade}
                    placeholder="7 (padrão do sistema)"
                    inputMode="numeric"
                    onChange={(e) => setValidade(e.target.value)}
                  />
                )}
              </Field>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Vale hoje:{' '}
                <ValorVigente
                  valor={String(politica.reservationValidDays)}
                  definido={politica.definidos.reservationValidDays}
                  sufixo="dia(s)"
                />
              </p>

              {/*
                O QUARTO CAMPO É DIFERENTE DOS TRÊS DE CIMA, e a tela tem de
                dizer isso — senão ela mente por omissão.

                Nos outros três, vazio herda um padrão do sistema: 10%, 0 dias,
                7 dias. Aqui vazio é AUSÊNCIA DE TRAVA. Não há número escondido
                atrás do campo em branco, e é justamente essa a leitura errada
                que o dono faria por analogia com os campos acima — ele veria
                três campos vazios funcionando como "o sistema decide" e
                concluiria que a gaveta também tem um limite qualquer decidido
                por alguém. Não tem: com o campo vazio, o operador retira o que
                quiser, até zerar, e a única testemunha é o movimento que ele
                mesmo lançou.

                Por isso o `hint` e a linha "Vale hoje" dizem SEM TETO com todas
                as letras, em vez de mostrarem um campo em branco calado.
              */}
              <Field
                label="Sangria que o caixa faz sem chamar gestor (R$)"
                hint="Em branco NÃO é um padrão do sistema: é SEM TETO — o operador retira qualquer valor da gaveta. Zero é o oposto: toda sangria chama o gestor."
              >
                {(p) => (
                  <Input
                    {...p}
                    value={tetoSangria}
                    placeholder="sem teto"
                    inputMode="decimal"
                    onChange={(e) => setTetoSangria(e.target.value)}
                  />
                )}
              </Field>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Vale hoje:{' '}
                {!temTeto(politica.cashWithdrawalLimitCents) ? (
                  /*
                    Não usa `ValorVigente`: aquele componente escolhe entre
                    "definido por você" e "padrão do sistema", e nenhum dos dois
                    é verdade aqui. Chamar a ausência de teto de "padrão do
                    sistema" seria dizer que alguém escolheu isso por segurança
                    — quando ninguém escolheu nada, e é o dono quem precisa
                    saber que a decisão está em aberto.
                  */
                  <span className="flex items-center gap-2 flex-wrap">
                    <strong className="text-[var(--gs-purple-900)]">Sem teto</strong>
                    <Badge tone="warning">a gaveta não tem limite</Badge>
                  </span>
                ) : (
                  <ValorVigente
                    valor={formatCents(politica.cashWithdrawalLimitCents)}
                    definido
                    sufixo="por sangria"
                  />
                )}
              </p>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                O teto não vale para quem já tem alçada — gerente e gestor sangram acima dele sem
                pedir liberação a ninguém, e a retirada fica gravada no nome de quem a fez. Em
                loja pequena o gerente é quem fica no caixa, e a sangria existe para tirar
                dinheiro da gaveta por segurança: travá-la para ele deixaria o dinheiro exposto
                justamente quando alguém decidiu protegê-lo. O PDV mostra o teto antes de o
                operador digitar o valor.
              </p>

              {/*
                O MOTIVO OBRIGATÓRIO E O LIMITE POR PERFIL (P0 da Preço Justo).

                O limite de cima era o ÚNICO número da alçada: igual para o caixa
                novo e para a atendente, só em %, só na venda inteira — e quem
                tinha perfil de gerente não tinha teto nenhum. Cada linha abaixo
                dá a um perfil tetos próprios, na venda e em cada item, em % e em
                R$. Só aparece quando o servidor conhece a tabela.
              */}
              {Array.isArray(politica.perfisComLimite) && (
                <>
                  <label className="flex items-start gap-2 text-[length:var(--gs-text-sm)]">
                    <input
                      type="checkbox"
                      aria-label="Exigir motivo na liberação de desconto"
                      checked={motivoObrigatorio}
                      onChange={(e) => setMotivoObrigatorio(e.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      <strong>Exigir motivo na liberação de desconto.</strong> A senha do gestor só
                      libera o desconto acima do limite com o porquê digitado — ele fica na auditoria
                      junto do nome de quem liberou e de quem pediu.
                    </span>
                  </label>

                  <div className="flex flex-col gap-2">
                    <strong className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-900)]">
                      Limite de desconto por perfil
                    </strong>
                    <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      Em branco é sem este teto — com uma exceção: o % da venda em branco, para quem
                      não tem alçada, é o limite de cima. Gerente e gestor sem linha aqui continuam
                      sem teto. Acima de qualquer teto o PDV pede a senha de um gestor, e o gestor só
                      libera dentro dos tetos do perfil dele. O item mede o desconto e o preço
                      rebaixado da linha; a venda mede tudo, rodapé incluído.
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
                        <thead>
                          <tr>
                            <th className="text-left p-1">Perfil</th>
                            <th className="text-left p-1">Venda (%)</th>
                            <th className="text-left p-1">Venda (R$)</th>
                            <th className="text-left p-1">Item (%)</th>
                            <th className="text-left p-1">Item (R$)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {limites.map((l) => {
                            const rotulo = ROTULO_DO_PERFIL[l.profileCode] ?? l.profileCode;
                            return (
                              <tr key={l.profileCode}>
                                <td className="p-1 whitespace-nowrap">{rotulo}</td>
                                {(Object.keys(ROTULO_DO_CAMPO) as CampoDoLimite[]).map((campo) => (
                                  <td key={campo} className="p-1 min-w-[6.5rem]">
                                    <Input
                                      aria-label={`${rotulo}: ${ROTULO_DO_CAMPO[campo]}`}
                                      value={l[campo]}
                                      inputMode="decimal"
                                      placeholder={
                                        campo === 'maxPercent' && !PERFIS_COM_ALCADA.has(l.profileCode)
                                          ? 'o de cima'
                                          : 'sem teto'
                                      }
                                      onChange={(e) => mudarLimite(l.profileCode, campo, e.target.value)}
                                    />
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              <div>
                <Button onClick={() => void salvar()} loading={salvando}>
                  Salvar política
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/*
        O critério de entrada, escrito onde quem pede a próxima coluna vai ler.
        A mesma frase está na DDL da tabela, no servidor. Sem este freio, a
        tela vira o depósito de quinze preferências que ninguém lê.
      */}
      <Card title="O que não entra nesta tela">
        <p>
          Aqui mora só <strong>política comercial do balcão</strong>: decisão do dono, sobre o que
          o operador pode fazer sozinho, com alguém no servidor lendo o valor. Regra fiscal, regra
          de estoque e preferência de aparência não entram — cada uma tem a sua tela, e misturá-las
          faria esta virar um painel de campos que ninguém sabe se são lidos.
        </p>
        <p>
          O critério é o terceiro item, e é o mais esquecido: <strong>campo novo só nasce com
          leitor no mesmo commit</strong>. O prazo de pagamento do fornecedor ficou anos com tela,
          coluna e gravação — e sem uma linha lendo. Toda compra nascia vencida no dia da chegada,
          e o painel financeiro mostrava um atraso que não existia.
        </p>
      </Card>
    </AppShell>
  );
}
