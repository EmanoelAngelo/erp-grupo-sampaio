/**
 * Administração › Integrações › Asaas.
 *
 * A tela responde duas perguntas: esta operação consegue receber online, e o
 * que falta para receber de verdade — não em sandbox.
 *
 * A credencial entra e não volta. O campo é de senha, esvazia depois de
 * gravar, e a API devolve dica mascarada em vez do valor. Quem precisa
 * conferir a chave confere no painel do Asaas, não aqui.
 *
 * "Homologado" e "produção" NÃO são caixas de seleção. São consequência das
 * cinco travas que o servidor confere; a tela mostra quais ainda estão
 * fechadas, porque prometer produção sem elas é prometer cobrança que não vai
 * acontecer.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { WebhookAsaasCard } from '@/components/gs/WebhookAsaasCard';
import { AsaasDoGrupoCard } from '@/components/gs/AsaasDoGrupoCard';
import { Badge, Button, Card, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type AsaasIntegration, type HomologacaoAsaas } from '@/lib/api/core';
import { dataHoraBR } from '@/lib/datas';

/** Cada tranca em português. Código de máquina não ajuda quem configura. */
const TRAVA_ROTULO: Record<string, string> = {
  CONFIGURACAO_EM_SANDBOX: 'A operação ainda não pediu produção.',
  PRODUCAO_DESABILITADA_NO_PROCESSO:
    'O servidor está com produção desligada (ASAAS_PRODUCTION_ENABLED).',
  SEM_CREDENCIAL_DE_PRODUCAO: 'Falta a API key de produção desta operação.',
  // GAP-PRD-170: a tranca é o teste da chave de PRODUÇÃO, em api.asaas.com —
  // o teste do sandbox não a abre mais.
  CREDENCIAL_DE_PRODUCAO_NAO_TESTADA:
    'A chave de produção ainda não foi testada contra o Asaas de produção. Use "Testar conexão".',
  CONEXAO_NAO_TESTADA: 'A conexão ainda não foi testada com a credencial atual.',
  HOMOLOGACAO_SANDBOX_PENDENTE: 'A homologação em sandbox ainda não foi concluída.',
};

function dataHora(iso: string | null | undefined): string {
  if (!iso) return 'nunca';
  return dataHoraBR(iso);
}

export default function IntegracaoAsaasPage() {
  const [dados, setDados] = useState<AsaasIntegration | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setDados(await coreApi.getAsaasIntegration());
    } catch (err) {
      setDados(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a integração.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const executar = useCallback(
    async (acao: () => Promise<unknown>, mensagem: string) => {
      setOcupado(true);
      setErro(null);
      setAviso(null);
      try {
        await acao();
        setAviso(mensagem);
        await carregar();
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'A operação falhou.');
      } finally {
        setOcupado(false);
      }
    },
    [carregar],
  );

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Administração', 'Integrações', 'Asaas']}
        title="Cobrança online (Asaas)"
        subtitle={
          <>
            A configuração é desta operação. Cada empresa do grupo recebe na conta dela. Com a chave
            no lugar, a cobrança de um título sai em{' '}
            {/*
              ONDE SE COBRA, dito aqui. Esta tela configura a credencial e não
              cobra nada — quem chega para "gerar um PIX para o cliente"
              precisa saber que o botão mora no título do contas a receber.
            */}
            <Link
              to="/sistema/financeiro/contas-a-receber"
              className="text-[var(--gs-purple-700)] font-semibold underline"
            >
              Financeiro › A receber
            </Link>
            , e a situação de cada cobrança aparece lá também.
          </>
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

      {dados && (
        <div className="flex flex-col gap-5">
          <SituacaoCard
            dados={dados}
            ocupado={ocupado}
            onTestar={() =>
              void executar(async () => {
                // Cada chave no próprio ambiente (GAP-PRD-170): a frase diz o
                // que o sandbox e a produção responderam, um por um.
                const r = await coreApi.testAsaasConnection();
                if (!r.ok) throw new ApiRequestError('ASAAS_TEST_FAILED', r.detail, 400);
              }, 'Conexão testada com sucesso em cada chave configurada.')
            }
          />

          <CredenciaisCard
            dados={dados}
            ocupado={ocupado}
            onGravarChave={(ambiente, chave) =>
              void executar(
                () => coreApi.saveAsaasApiKey(ambiente, chave),
                `Chave de ${ambiente === 'production' ? 'produção' : 'sandbox'} guardada no cofre.`,
              )
            }
            onRemoverChave={(ambiente) =>
              void executar(() => coreApi.removeAsaasApiKey(ambiente), 'Chave removida.')
            }
            onGravarToken={(token) =>
              void executar(
                () => coreApi.saveAsaasWebhookToken(token),
                'Token do webhook guardado no cofre.',
              )
            }
          />

          {/* A URL que se cola no painel do Asaas, e se o aviso está chegando
              (GAP-PRD-002). Antes a tela tinha o token e nenhuma URL. */}
          {dados.webhook && (
            <WebhookAsaasCard
              webhook={dados.webhook}
              tokenConfigurado={dados.credentials.webhook.configured}
              tokenDoAmbiente={dados.credentials.webhook.source === 'env'}
            />
          )}

          <ProducaoCard
            dados={dados}
            ocupado={ocupado}
            onPedir={(ambiente) =>
              void executar(
                () => coreApi.requestAsaasEnvironment(ambiente),
                ambiente === 'production'
                  ? 'Pedido de produção registrado.'
                  : 'Operação voltou para sandbox.',
              )
            }
          />

          {/* O que falta em cada operação do grupo (GAP-PRD-017) — só para os
              donos; some para quem o servidor recusa. */}
          <AsaasDoGrupoCard />
        </div>
      )}
    </AppShell>
  );
}

function SituacaoCard({
  dados,
  ocupado,
  onTestar,
}: {
  dados: AsaasIntegration;
  ocupado: boolean;
  onTestar: () => void;
}) {
  const { status, state } = dados;
  const producao = status.environment === 'production';

  return (
    <Card
      title="Situação"
      subtitle="Ambiente efetivo é o que o servidor vai usar de verdade — não o que foi pedido."
      actions={
        <Button variant="ghost" loading={ocupado} onClick={onTestar}>
          Testar conexão
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3 items-center">
          <Badge tone={status.configured ? 'success' : 'neutral'}>
            {status.configured ? 'Credencial configurada' : 'Sem credencial'}
          </Badge>
          <Badge tone={producao ? 'danger' : 'info'}>
            {producao ? 'PRODUÇÃO — cobrança real' : 'Sandbox — nenhuma cobrança real'}
          </Badge>
          {/*
            UM SELO POR CHAVE (GAP-PRD-170). "Conexão verificada" era um selo
            só, carimbado pelo teste do ambiente efetivo — o sandbox, enquanto a
            produção estava trancada —, e abria a tranca da produção sem ninguém
            ter testado a chave de produção.
          */}
          <Badge tone={state.connectionVerified ? 'success' : 'warning'}>
            {state.connectionVerified ? 'Sandbox: conexão verificada' : 'Sandbox: conexão não verificada'}
          </Badge>
          {dados.credentials.production.configured && (
            <Badge tone={state.productionConnectionVerified ? 'success' : 'warning'}>
              {state.productionConnectionVerified
                ? 'Produção: chave testada'
                : 'Produção: chave não testada'}
            </Badge>
          )}
          <Badge tone={state.sandboxHomologated ? 'success' : 'warning'}>
            {state.sandboxHomologated ? 'Homologada em sandbox' : 'Homologação pendente'}
          </Badge>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 m-0">
          <Linha rotulo="Ambiente efetivo" valor={producao ? 'Produção' : 'Sandbox'} />
          <Linha rotulo="Ambiente pedido" valor={state.environment === 'production' ? 'Produção' : 'Sandbox'} />
          <Linha rotulo="Último teste do sandbox" valor={dataHora(state.lastConnectionTestAt)} />
          <Linha
            rotulo="Último teste da produção"
            valor={dataHora(state.productionConnectionTestedAt ?? null)}
          />
          <Linha rotulo="Última homologação" valor={dataHora(state.lastHomologationAt)} />
        </dl>

        {state.productionConnectionError && !state.productionConnectionVerified && (
          <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
            A chave de produção foi recusada no último teste: {state.productionConnectionError}
          </p>
        )}

        {dados.credentials.sandbox.source === 'env' && dados.envFallbackAllowed && (
          <p
            role="status"
            className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] m-0"
          >
            Esta operação está usando a chave do AMBIENTE, não uma chave própria. Serve para
            desenvolvimento; em produção o servidor recusa esse atalho. Guarde a chave da operação
            abaixo.
          </p>
        )}
      </div>
    </Card>
  );
}

function CredenciaisCard({
  dados,
  ocupado,
  onGravarChave,
  onRemoverChave,
  onGravarToken,
}: {
  dados: AsaasIntegration;
  ocupado: boolean;
  onGravarChave: (ambiente: 'sandbox' | 'production', chave: string) => void;
  onRemoverChave: (ambiente: 'sandbox' | 'production') => void;
  onGravarToken: (token: string) => void;
}) {
  const [sandbox, setSandbox] = useState('');
  const [producao, setProducao] = useState('');
  const [token, setToken] = useState('');

  return (
    <Card
      title="Credenciais"
      subtitle="Guardadas no cofre do servidor. Nunca voltam por esta tela nem pela API."
    >
      <div className="flex flex-col gap-5">
        <LinhaCredencial
          rotulo="API key — sandbox"
          dica="Testes. Nenhuma cobrança real acontece neste ambiente."
          slot={dados.credentials.sandbox}
          valor={sandbox}
          ocupado={ocupado}
          onChange={setSandbox}
          onGravar={() => {
            onGravarChave('sandbox', sandbox);
            setSandbox('');
          }}
          onRemover={() => onRemoverChave('sandbox')}
        />

        <LinhaCredencial
          rotulo="API key — produção"
          dica="Cobrança de verdade, no CNPJ desta operação. Guardar não liga a produção sozinho."
          slot={dados.credentials.production}
          valor={producao}
          ocupado={ocupado}
          onChange={setProducao}
          onGravar={() => {
            onGravarChave('production', producao);
            setProducao('');
          }}
          onRemover={() => onRemoverChave('production')}
        />

        <LinhaCredencial
          rotulo="Token do webhook"
          dica="É com ele que o Asaas se identifica ao avisar que um pagamento caiu."
          slot={dados.credentials.webhook}
          valor={token}
          ocupado={ocupado}
          onChange={setToken}
          onGravar={() => {
            onGravarToken(token);
            setToken('');
          }}
        />

        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          Trocar ou remover a chave de sandbox derruba a conexão do sandbox e a homologação; trocar
          ou remover a de produção derruba só o teste da produção. Cada selo era da chave anterior
          — e só dela.
        </p>
      </div>
    </Card>
  );
}

function LinhaCredencial({
  rotulo,
  dica,
  slot,
  valor,
  ocupado,
  onChange,
  onGravar,
  onRemover,
}: {
  rotulo: string;
  dica: string;
  slot: { configured: boolean; maskedHint?: string; source: string };
  valor: string;
  ocupado: boolean;
  onChange: (v: string) => void;
  onGravar: () => void;
  onRemover?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 pb-4 border-b border-[var(--gs-border)] last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold text-[var(--gs-purple-900)]">{rotulo}</span>
        <Badge tone={slot.configured ? 'success' : 'neutral'}>
          {slot.configured ? `Configurada (${slot.maskedHint ?? 'oculta'})` : 'Não configurada'}
        </Badge>
        {slot.configured && (
          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            origem: {slot.source === 'vault' ? 'cofre desta operação' : 'ambiente do servidor'}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[260px]">
          <Field label={rotulo} hint={dica}>
            {(p) => (
              <Input
                {...p}
                // Campo de senha: a credencial não fica legível na tela nem no
                // histórico de formulário do navegador.
                type="password"
                autoComplete="off"
                value={valor}
                onChange={(e) => onChange(e.target.value)}
                placeholder={slot.configured ? 'Substituir a atual' : 'Colar a credencial'}
              />
            )}
          </Field>
        </div>
        <Button disabled={ocupado || valor.trim().length < 8} onClick={onGravar}>
          Guardar
        </Button>
        {onRemover && slot.configured && slot.source === 'vault' && (
          <Button variant="ghost" disabled={ocupado} onClick={onRemover}>
            Remover
          </Button>
        )}
      </div>
    </div>
  );
}

function ProducaoCard({
  dados,
  ocupado,
  onPedir,
}: {
  dados: AsaasIntegration;
  ocupado: boolean;
  onPedir: (ambiente: 'sandbox' | 'production') => void;
}) {
  const travas = dados.status.productionBlockedBy;
  const liberado = travas.length === 0;

  return (
    <Card
      title="Produção"
      subtitle="Cobrar de verdade exige que todas as travas abaixo estejam abertas."
    >
      <div className="flex flex-col gap-4">
        {liberado ? (
          <p
            role="status"
            className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-success)] m-0"
          >
            Todas as travas abertas. Esta operação cobra em produção.
          </p>
        ) : (
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {travas.map((trava) => (
              <li
                key={trava}
                className="flex gap-2 items-start text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]"
              >
                <span aria-hidden className="text-[var(--gs-warning)]">
                  ●
                </span>
                <span>{TRAVA_ROTULO[trava] ?? trava}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-3">
          <Button
            variant="ghost"
            disabled={ocupado || dados.state.environment === 'production'}
            onClick={() => onPedir('production')}
          >
            Pedir produção
          </Button>
          <Button
            variant="ghost"
            disabled={ocupado || dados.state.environment !== 'production'}
            onClick={() => onPedir('sandbox')}
          >
            Voltar para sandbox
          </Button>
        </div>

        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          Pedir produção registra a intenção. O ambiente efetivo continua sandbox enquanto houver
          trava fechada.
        </p>

        {/*
          A HOMOLOGAÇÃO GANHA BOTÃO (rodada 62). Ela é uma das travas listadas
          acima, e era a única que o dono não tinha como abrir: o motor existia,
          a rota antiga exigia uma permissão que nenhum perfil tem, e nenhuma
          tela chamava qualquer uma das duas. Listar uma trava sem oferecer o
          caminho é a tela cobrando o que ela mesma não deixa fazer.
        */}
        <HomologacaoBloco
          passosGravados={
            (dados.state as { homologationSteps?: HomologacaoAsaas['steps'] }).homologationSteps ?? []
          }
        />
      </div>
    </Card>
  );
}

/**
 * A HOMOLOGAÇÃO DO SANDBOX, COM OS PASSOS NA TELA — rodada 62.
 *
 * ## O que ela faz, e por que os passos aparecem
 *
 * O que é EXECUTADO contra o sandbox do Asaas: cria cliente, consulta, gera
 * cobrança PIX, pega o QR, gera boleto, lê a linha digitável, abre o checkout,
 * prova a idempotência da fila, manda o corpo da cobrança do título (e a
 * cancela), faz a consulta da conciliação e passa um aviso pelo webhook do ERP
 * com o token da operação. O último passo — o aviso do próprio Asaas chegando
 * ao servidor — só fica verde quando o aviso chega (GAP-PRD-169).
 *
 * A frase antiga dizia que a homologação "escreve em Contas a Receber,
 * concilia e recebe o próprio webhook", e três desses passos eram verdes por
 * atribuição. Um selo de homologação com passos decorativos é pior do que
 * nenhum: dá confiança sem prova.
 *
 * Quando falha, dizer só "não passou" não ajuda ninguém: o que conserta é
 * saber QUAL passo caiu e o que o Asaas respondeu. Por isso a lista fica na
 * tela, com o veredito de cada um — e continua lá depois de recarregar, lida
 * do estado gravado.
 *
 * ## Nada disso é dinheiro de verdade
 *
 * É o ambiente de testes do Asaas — as cobranças criadas aqui não existem para
 * ninguém, e nenhum título é criado no Contas a Receber da operação.
 */
function HomologacaoBloco({ passosGravados }: { passosGravados: HomologacaoAsaas['steps'] }) {
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<HomologacaoAsaas | null>(null);
  const [passos, setPassos] = useState<HomologacaoAsaas['steps']>(passosGravados);
  const [falha, setFalha] = useState<string | null>(null);

  useEffect(() => {
    setPassos(passosGravados);
  }, [passosGravados]);

  const rodar = async () => {
    setOcupado(true);
    setFalha(null);
    setResultado(null);
    try {
      const r = await coreApi.homologarAsaas();
      setResultado(r);
      setPassos(r.steps);
    } catch (err) {
      setFalha(
        err instanceof ApiRequestError ? err.message : 'Não foi possível homologar agora.',
      );
    } finally {
      setOcupado(false);
    }
  };

  const conferirAviso = async () => {
    setOcupado(true);
    setFalha(null);
    try {
      const r = await coreApi.conferirAvisoDaHomologacaoAsaas();
      setPassos(r.steps);
    } catch (err) {
      setFalha(err instanceof ApiRequestError ? err.message : 'Não foi possível conferir o aviso agora.');
    } finally {
      setOcupado(false);
    }
  };

  const passou = resultado?.status === 'passed';
  const avisoAguardando = passos.some((p) => p.key === 'webhook_external' && p.status === 'awaiting_external');

  return (
    <div className="border-t border-[var(--gs-border)] pt-4">
      <p className="m-0 font-semibold text-[length:var(--gs-text-base)]">
        Homologação em sandbox
      </p>
      <p className="m-0 mt-1 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
        Executa no ambiente de testes do Asaas o que o ERP vai pedir de verdade: cliente, PIX,
        boleto, checkout, o corpo da cobrança do título, a consulta da conciliação e o aviso pelo
        webhook do ERP. Nenhuma cobrança real é criada, e nenhum título entra no Contas a Receber.
      </p>

      <div className="flex flex-wrap gap-3">
        <Button variant="ghost" loading={ocupado} onClick={() => void rodar()}>
          Rodar homologação
        </Button>
        {avisoAguardando && (
          <Button variant="ghost" disabled={ocupado} onClick={() => void conferirAviso()}>
            Conferir se o aviso do Asaas chegou
          </Button>
        )}
      </div>

      {falha && (
        <p
          role="alert"
          className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {falha}
        </p>
      )}

      {passos.length > 0 && (
        <div className="mt-3">
          {resultado && (
            <p
              role="status"
              className={`m-0 mb-2 px-3 py-2 rounded-[var(--gs-radius)] font-semibold
                text-[length:var(--gs-text-sm)] ${
                passou
                  ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
                  : 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]'
              }`}
            >
              {passou
                ? 'Homologação concluída — esta trava está aberta.'
                : 'A homologação não passou. Veja abaixo qual passo falhou.'}
            </p>
          )}

          {/*
            TRÊS ESTADOS, TRÊS MARCAS — e a rodada 63 nasceu de confundi-los.

            O serviço marca o passo que caiu como `error` (não `failed`) e
            grava o motivo em `message` (não `detail`). A tela procurava as
            duas palavras erradas: o passo culpado saía com a MESMA marca dos
            que nem chegaram a rodar, e o motivo não aparecia. Resultado: a
            caixa dizia "veja abaixo qual passo falhou" e não havia como ver.

            `pending` não é falha: a sequência para no primeiro erro, e os
            seguintes ficam sem rodar. Mostrá-los como problema faria o dono
            procurar defeito em passos inocentes.
          */}
          {/*
            E MAIS DOIS ESTADOS, QUE NÃO SÃO VERDES (GAP-PRD-169): `not_applicable`
            (não há o que executar no sandbox, e a frase diz por quê) e
            `awaiting_external` (o aviso do Asaas ainda não chegou). Pintá-los
            de verde era o selo decorativo que esta rodada tirou.
          */}
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            {passos.map((passo) => {
              const caiu = passo.status === 'error' || passo.status === 'failed';
              const naoRodou = passo.status === 'pending' || passo.status === 'skipped';
              const naoSeAplica = passo.status === 'not_applicable';
              const aguardando = passo.status === 'awaiting_external';
              const motivo = passo.message ?? passo.detail;
              return (
                <li
                  key={passo.key}
                  data-testid={`passo-${passo.key}`}
                  className="flex gap-2 items-start text-[length:var(--gs-text-sm)]"
                >
                  <span
                    aria-hidden
                    className={
                      passo.status === 'success'
                        ? 'text-[var(--gs-success)]'
                        : caiu
                          ? 'text-[var(--gs-danger)]'
                          : aguardando
                            ? 'text-[var(--gs-warning)]'
                            : 'text-[var(--gs-muted)]'
                    }
                  >
                    {passo.status === 'success' ? '✓' : caiu ? '✕' : aguardando ? '…' : naoSeAplica ? '–' : '•'}
                  </span>
                  <span className={caiu ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-text-soft)]'}>
                    {passo.label}
                    {naoRodou && (
                      <span className="text-[var(--gs-muted)]"> — não chegou a rodar</span>
                    )}
                    {naoSeAplica && <span className="text-[var(--gs-muted)]"> — não se aplica</span>}
                    {aguardando && <span className="text-[var(--gs-warning)]"> — aguardando</span>}
                    {/* O motivo vem do Asaas e chega inteiro: é ele que diz o
                        que consertar. */}
                    {motivo && !naoRodou ? (
                      <span className={caiu ? '' : 'text-[var(--gs-muted)]'}> — {motivo}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-muted)]">
        {rotulo}
      </dt>
      <dd className="m-0 text-[length:var(--gs-text-base)] text-[var(--gs-text)]">{valor}</dd>
    </div>
  );
}
