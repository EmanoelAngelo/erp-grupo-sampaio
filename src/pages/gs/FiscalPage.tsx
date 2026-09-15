/**
 * Configuração fiscal e prontidão para emitir.
 *
 * A tela responde UMA pergunta: esta operação já pode emitir nota? E quando a
 * resposta é não, ela diz qual campo falta — não "erro de configuração".
 *
 * O CHECKLIST VEM PRIMEIRO, antes do formulário, de propósito. Quem abre esta
 * tela quer saber o que está faltando; o formulário é o meio, não o assunto.
 *
 * NADA DE SEGREDO PASSA POR AQUI. O certificado e o CSC vivem cifrados no
 * cofre do backend; esta tela só pergunta se existem. Senha de certificado e
 * token de CSC nunca chegam ao navegador.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, DataTable, Field, Input, PageHeader } from '@/components/gs/ui';
import { AvisoDeVencimento } from '@/components/gs/CertificadoValidado';
import { NfseConfigCard } from '@/components/gs/NfseConfigCard';
import { EmissaoNoFinalizarCard } from '@/components/gs/EmissaoNoFinalizarCard';
import { CidadeComSugestoes } from '@/components/gs/CidadeComSugestoes';
import { useTabelaDeMunicipios } from '@/hooks/useTabelaDeMunicipios';
import { UFS } from '@/lib/api/municipios';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type CampoFiscal,
  type ClassificationSummary,
  type FiscalConfig,
  type NfceCscSetting,
  type ProductClassification,
  type ProductFiscalPendency,
  type ProductionUnlock,
  type ReadinessOwner,
  type ReadinessReport,
  type ReadinessSource,
  type ReadinessState,
} from '@/lib/api/core';
import { dataHoraBR } from '@/lib/datas';
import { uuid } from '@/lib/uuid';
import { fraseDaReleitura, releituraDoXmlApi } from '@/lib/api/releituraDoXml';

const MODELO_ROTULO: Record<string, string> = {
  '65': 'NFC-e (cupom, modelo 65)',
  '55': 'NF-e (modelo 55)',
};

const READINESS_ROTULO: Record<string, { texto: string; tom: 'neutral' | 'warning' | 'success' }> = {
  READY_FOR_CERTIFICATE: { texto: 'AGUARDA CERTIFICADO', tom: 'neutral' },
  READY_FOR_SEFAZ_HOMOLOGATION: { texto: 'PRONTA PARA HOMOLOGAÇÃO', tom: 'warning' },
  HOMOLOGATED: { texto: 'HOMOLOGADA', tom: 'success' },
};

export default function FiscalPage() {
  const [config, setConfig] = useState<FiscalConfig | null>(null);
  const [relatorios, setRelatorios] = useState<ReadinessReport[] | null>(null);
  const [producao, setProducao] = useState<ProductionUnlock | null>(null);
  const [resumo, setResumo] = useState<ClassificationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setError(null);
    try {
      const [c, r] = await Promise.all([
        coreApi.getFiscalConfig(),
        coreApi.getFiscalReadiness(),
      ]);
      setConfig(c);
      setRelatorios(r.items);
      setProducao(r.productionUnlock);
      setResumo(r.classification ?? null);
    } catch (err) {
      setConfig(null);
      setRelatorios(null);
      setProducao(null);
      setResumo(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <AppShell>
      <PageHeader breadcrumb={['Fiscal', 'Configuração']} title="Emissão fiscal" />

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

      {/*
        O AVISO DO CERTIFICADO VEM ANTES DE TUDO (GAP-V40).

        Quem abre esta tela está prestes a mexer na emissão; se o A1 vence em
        duas semanas, é a primeira coisa que precisa saber — antes do
        checklist, antes do formulário. Com folga, nada é renderizado.
      */}
      {relatorios?.[0]?.certificateAlert && (
        <div className="mb-5">
          <AvisoDeVencimento alerta={relatorios[0].certificateAlert} />
        </div>
      )}

      {/* O ambiente é a informação mais perigosa da tela: emitir em produção
          por engano gera nota real com valor jurídico. */}
      {config && (
        <div className="mb-5">
          <AmbienteCard
            config={config}
            producao={producao}
            onMudou={async (mensagem) => {
              setAviso(mensagem);
              await carregar();
            }}
            onErro={setError}
          />
        </div>
      )}

      {relatorios && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
          {relatorios.map((r) => (
            <ChecklistCard key={r.model} relatorio={r} />
          ))}
        </div>
      )}

      {/*
        A MÃO DE OBRA TEM DOCUMENTO PRÓPRIO (GAP-PRD-024). A peça da OS sai na
        NFC-e acima; o serviço sai na NFS-e, com o modo decidido pelo dono e os
        códigos informados pelo contador.
      */}
      <div className="mb-5">
        <NfseConfigCard onMudou={setAviso} />
      </div>

      {/*
        A NFC-e NO FINALIZAR (GAP-PRD-163): manual (padrão) ou automática. É
        decisão do dono, e é aqui que ela se toma — ao lado do resto da emissão.
      */}
      <div className="mb-5">
        <EmissaoNoFinalizarCard />
      </div>

      {/*
        O QUE O SISTEMA JÁ DESCOBRIU vem ANTES do que ele cobra.

        A ordem não é estética: a lista de pendências manda preencher; esta
        manda CONFERIR o que já está preenchido de graça. Quem abre a tela com
        trinta produtos sem NCM e vinte deles já resolvidos pelo XML precisa
        ver os vinte primeiro — senão desiste antes de descobrir que o trabalho
        era um terço do que parecia.
      */}
      <div className="mb-5">
        <SugestoesDoXmlCard resumo={resumo} onConfirmado={carregar} onErro={setError} />
      </div>

      <div className="mb-5">
        <PendenciasProdutosCard onCorrigido={carregar} />
      </div>

      {config && (
        <EmitenteCard
          config={config}
          onSalvo={async (mensagem) => {
            setAviso(mensagem);
            await carregar();
          }}
          onErro={setError}
        />
      )}

      <div className="mt-5">
        <NumeracaoCard
          onSalvo={async (mensagem) => {
            setAviso(mensagem);
            await carregar();
          }}
          onErro={setError}
        />
      </div>

      {config && (
        <div className="mt-5">
          <CscCard
            ambiente={config.environment}
            onSalvo={async (mensagem) => {
              setAviso(mensagem);
              await carregar();
            }}
            onErro={setError}
          />
        </div>
      )}
    </AppShell>
  );
}

/**
 * ============================================================================
 * O AMBIENTE, E A CHAVE DA PRODUÇÃO — GAP-V42
 * ============================================================================
 *
 * O cartão dizia "Produção bloqueada" e não oferecia caminho nenhum para
 * desbloqueá-la: a coluna `production_unlocked` não tinha escritor, e o go-live
 * exigiria um UPDATE na mão no banco. Agora existe o ato, e ele é auditado.
 *
 * ## O botão é honesto sobre três coisas
 *
 * 1. POR QUE está desligado — a lista de pendências vem do servidor, não de um
 *    palpite da tela;
 * 2. QUAL é a prova que o liberou — protocolo, modelo e número da nota real
 *    autorizada na homologação;
 * 3. O QUE AINDA FALTA depois de clicar. Destravar NÃO liga produção: o
 *    ambiente da operação continua onde está, o CSC de produção é outro, e o
 *    servidor precisa estar fora do modo de desenvolvimento. Um botão que
 *    dissesse "produção ligada" mentiria em dois terços.
 */
/**
 * ============================================================================
 * A VIRADA DO AMBIENTE — o gesto que o próprio servidor mandava fazer aqui
 * ============================================================================
 *
 * ## O defeito
 *
 * Depois de liberar a produção, o servidor devolve, como primeiro passo
 * restante: "Virar o ambiente desta operação para «produção» em Fiscal ›
 * Configuração — outro ato, depois deste." Esta é a tela. E ela não tinha o
 * controle: o `AmbienteCard` só RENDERIZAVA `config.environment` num badge.
 *
 * As outras três camadas aceitavam a virada — `environment` está no mapa do
 * PATCH de `updateFiscalConfig`, a rota existe, `coreApi.updateFiscalConfig`
 * existe —, e o ÚNICO chamador era o `EmitenteCard`, cujo formulário tem as 14
 * chaves do endereço e nenhuma delas é `environment`. O dono lia o passo,
 * abria a tela e não achava nada; o go-live terminava num UPDATE à mão no
 * banco. Instruir um gesto que não se oferece é defeito próprio desta casa.
 *
 * ## Por que é um Record TOTAL, e não dois `if`
 *
 * Ambiente é um par fechado, e cada metade tem rótulo, tom, o que muda e para
 * onde a virada leva. Escrito como condicional espalhada, um terceiro ambiente
 * (contingência, por exemplo) entraria calado pela metade. Aqui ele quebra a
 * COMPILAÇÃO — que é o jeito desta casa de não ter lista escrita à mão.
 */
type Ambiente = FiscalConfig['environment'];

const AMBIENTE: Record<
  Ambiente,
  {
    badge: string;
    tom: 'danger' | 'info';
    /** O que vale enquanto a operação estiver AQUI. */
    enquantoAqui: string;
    /** Para onde esta tela leva, e como o gesto se chama. */
    virada: {
      destino: Ambiente;
      botao: string;
      confirmar: string;
      /** O que passa a valer DEPOIS da virada — dito antes de virar. */
      oQueMuda: string;
      /** Produção exige a palavra digitada; a volta, não. */
      exigePalavra: boolean;
      aviso: string;
    };
  }
> = {
  homologation: {
    badge: 'HOMOLOGAÇÃO',
    tom: 'info',
    enquantoAqui: 'Nota emitida aqui não tem valor fiscal.',
    virada: {
      destino: 'production',
      botao: 'Virar para produção',
      confirmar: 'Confirmar a virada',
      oQueMuda:
        'A partir da virada, toda nota emitida por esta operação passa a ter valor jurídico: '
        + 'vai para a SEFAZ de produção, entra na apuração do contador e só sai de lá por '
        + 'cancelamento ou inutilização, dentro do prazo legal.',
      exigePalavra: true,
      aviso:
        'Confira antes: o CSC de PRODUÇÃO já gravado (o de homologação não assina o QR que '
        + 'vale) e o servidor rodando fora do modo de desenvolvimento.',
    },
  },
  production: {
    badge: 'PRODUÇÃO',
    tom: 'danger',
    enquantoAqui: 'Cada nota emitida aqui tem valor jurídico.',
    virada: {
      destino: 'homologation',
      botao: 'Voltar para homologação',
      confirmar: 'Confirmar a volta',
      oQueMuda:
        'A partir da volta, as notas emitidas deixam de ter valor fiscal e vão para a SEFAZ '
        + 'de homologação. As notas já autorizadas em produção continuam valendo — voltar '
        + 'não desfaz nenhuma delas.',
      exigePalavra: false,
      aviso:
        'A numeração de produção fica onde está: ela não recua, e a próxima nota de produção '
        + 'continuará do número em que parou.',
    },
  },
};

/**
 * A palavra que confirma a virada para produção.
 *
 * Aceita com e sem acento porque o teclado da loja nem sempre coopera, e NÃO
 * aceita minúscula: digitar em caixa alta é a parte deliberada do gesto.
 */
const PALAVRAS_DA_VIRADA = new Set(['PRODUÇÃO', 'PRODUCAO']);

function AmbienteCard({
  config,
  producao,
  onMudou,
  onErro,
}: {
  config: FiscalConfig;
  producao: ProductionUnlock | null;
  onMudou: (mensagem: string) => Promise<void>;
  onErro: (mensagem: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [palavra, setPalavra] = useState('');
  const [virandoBusy, setVirandoBusy] = useState(false);

  /*
    O AMBIENTE VEM DO SERVIDOR — E PODE NÃO SER NENHUM DOS DOIS.

    `Ambiente` é união fechada e o `Record` é total, então o compilador garante
    que os dois casos conhecidos têm entrada. O que ele NÃO garante é o valor
    que chega em tempo de execução: a configuração ainda não carregada, um
    campo ausente numa resposta antiga, um terceiro ambiente inventado depois.
    `AMBIENTE[<desconhecido>]` devolve `undefined`, e o `const { virada } =`
    seco derrubava a TELA INTEIRA com "Cannot destructure property 'virada'" —
    a página fiscal não abria, e o erro não dizia nada sobre ambiente.

    O fallback não pode ser "trate como homologação": o cartão escreveria
    HOMOLOGAÇÃO sobre uma operação que talvez esteja em produção, e ofereceria
    a virada errada. Ambiente desconhecido é ESTADO PRÓPRIO — a tela diz que
    não sabe e não oferece gesto nenhum, que é a única resposta honesta.
  */
  const atual = AMBIENTE[config.environment as Ambiente] as
    | (typeof AMBIENTE)[Ambiente]
    | undefined;
  const virada = atual?.virada;
  /*
    O SERVIDOR RECUSA A VIRADA PARA PRODUÇÃO COM 409 ENQUANTO O DESBLOQUEIO NÃO
    EXISTIR. Um botão ligado aqui seria um convite ao 409 — a tela repetiria a
    promessa que o cartão inteiro existe para não fazer. A volta para
    homologação não tem trava: sair de produção é sempre permitido.
  */
  const liberado = virada?.destino === 'production' ? config.productionUnlocked : true;
  const palavraConfere =
    !virada?.exigePalavra || PALAVRAS_DA_VIRADA.has(palavra.trim().normalize('NFC'));

  const virarAmbiente = useCallback(async () => {
    // Sem ambiente conhecido não há destino — e sem destino não há gesto.
    if (!virada) return;
    setVirandoBusy(true);
    try {
      /*
        SÓ `environment`, e nada mais. O `EmitenteCard` manda as 14 chaves do
        endereço no mesmo PATCH; se a virada saísse de lá, salvar o telefone
        mudaria o ambiente junto — e ninguém saberia qual dos dois atos foi.
      */
      await coreApi.updateFiscalConfig({ environment: virada.destino });
      setConfirmando(false);
      setPalavra('');
      await onMudou(
        virada.destino === 'production'
          ? 'Ambiente virado para PRODUÇÃO. As próximas notas têm valor jurídico.'
          : 'Ambiente de volta em homologação. As próximas notas não têm valor fiscal.',
      );
    } catch (err) {
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao virar o ambiente.');
    } finally {
      setVirandoBusy(false);
    }
  }, [virada, onMudou, onErro]);

  const liberar = useCallback(async () => {
    setBusy(true);
    try {
      const parecer = await coreApi.unlockFiscalProduction();
      await onMudou(
        parecer.alreadyUnlocked
          ? 'A produção já estava liberada nesta operação.'
          : 'Produção liberada. Ela ainda NÃO está ligada: falta virar o ambiente desta operação.',
      );
    } catch (err) {
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao liberar a produção.');
    } finally {
      setBusy(false);
    }
  }, [onMudou, onErro]);

  return (
    <Card
      title="Ambiente"
      subtitle="Produção exige configuração completa, certificado válido e uma autorização real na homologação."
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Badge tone={atual?.tom ?? 'neutral'}>{atual?.badge ?? 'AMBIENTE DESCONHECIDO'}</Badge>
          <Badge tone={config.productionUnlocked ? 'success' : 'neutral'}>
            {config.productionUnlocked ? 'PRODUÇÃO LIBERADA' : 'PRODUÇÃO BLOQUEADA'}
          </Badge>
          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {atual?.enquantoAqui
              ?? 'O servidor respondeu um ambiente que esta tela nao conhece — nao da para dizer se a nota vale.'}
          </span>
        </div>

        {producao?.unlocked && (
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Liberada em {dataHoraBR(producao.unlockedAt)}
            {producao.evidence
              ? ` · prova: modelo ${producao.evidence.model}, nota ${producao.evidence.number}, `
                + `protocolo ${producao.evidence.protocol}`
              : ''}
            .
          </p>
        )}

        {producao && !producao.unlocked && (
          <>
            {producao.blockingReasons.length > 0 && (
              <div>
                <p className="m-0 mb-2 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                  O que falta para liberar:
                </p>
                <ul className="m-0 pl-4 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] flex flex-col gap-1">
                  {producao.blockingReasons.map((motivo) => (
                    <li key={motivo}>{motivo}</li>
                  ))}
                </ul>
              </div>
            )}

            {producao.canUnlock && producao.evidence && (
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)] font-semibold">
                Homologação comprovada: modelo {producao.evidence.model}, nota{' '}
                {producao.evidence.number}, protocolo {producao.evidence.protocol}.
              </p>
            )}

            <div>
              <Button
                loading={busy}
                disabled={!producao.canUnlock}
                onClick={() => void liberar()}
              >
                Liberar produção
              </Button>
            </div>
          </>
        )}

        {/*
          O GESTO QUE O PASSO DO SERVIDOR MANDA FAZER — e que não existia.

          Ele fica DEPOIS de "Liberar produção" de propósito: é essa a ordem da
          cadeia, e o cartão inteiro é a cadeia por extenso.
        */}
        {/*
          Sem ambiente conhecido não há virada a oferecer: para onde levaria?
          Desenhar o bloco com um destino inventado é a porta que não abre.
        */}
        {virada && (
        <div className="pt-4 border-t border-[var(--gs-border)] flex flex-col gap-3">
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Ambiente desta operação
            </p>
            <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {virada.oQueMuda}
            </p>
          </div>

          {!liberado && (
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Libere a produção antes: enquanto o desbloqueio não existir, o servidor recusa a
              virada — e um botão que convidasse a essa recusa seria outra promessa vazia.
            </p>
          )}

          {!confirmando && (
            <div>
              <Button
                variant={virada.destino === 'production' ? 'primary' : 'ghost'}
                disabled={!liberado}
                onClick={() => {
                  setPalavra('');
                  setConfirmando(true);
                }}
              >
                {virada.botao}
              </Button>
            </div>
          )}

          {confirmando && (
            <div
              className="flex flex-col gap-3 p-3 rounded-[var(--gs-radius)]
                bg-[var(--gs-surface-hover)]"
            >
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                {virada.aviso}
              </p>

              {virada.exigePalavra && (
                <Field
                  label="Digite PRODUÇÃO para confirmar"
                  hint="Um clique não basta para um ato que passa a valer contra a SEFAZ."
                >
                  {(props) => (
                    <Input
                      {...props}
                      value={palavra}
                      onChange={(e) => setPalavra(e.target.value)}
                      placeholder="PRODUÇÃO"
                    />
                  )}
                </Field>
              )}

              <div className="flex gap-2">
                <Button
                  loading={virandoBusy}
                  disabled={!palavraConfere}
                  onClick={() => void virarAmbiente()}
                >
                  {virada.confirmar}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setConfirmando(false);
                    setPalavra('');
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>
        )}

        {/*
          A CADEIA INTEIRA, SEMPRE VISÍVEL. Os passos vêm do servidor para que
          a tela não invente uma sequência própria que envelheça sozinha — a
          régua de "o que ainda falta" é a mesma que o portão da emissão usa.
        */}
        {producao && (
          <details className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            <summary className="cursor-pointer font-semibold">
              Liberar produção não liga produção — o que mais é preciso
            </summary>
            <ol className="m-0 mt-2 pl-5 flex flex-col gap-1">
              {producao.remainingSteps.map((passo) => (
                <li key={passo}>{passo}</li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </Card>
  );
}

/**
 * Numeração das séries — o item `serie` do checklist.
 *
 * A série e o número são o que identifica a nota junto com o CNPJ e a chave.
 * Por isso a tela deixa AVANÇAR e não deixa recuar: repetir um número já
 * enviado à SEFAZ é rejeição por duplicidade, com a venda já registrada. O
 * servidor recusa a regressão; aqui a recusa aparece como texto, não como
 * campo que "não salvou".
 */
function NumeracaoCard({
  onSalvo,
  onErro,
}: {
  onSalvo: (mensagem: string) => Promise<void>;
  onErro: (mensagem: string) => void;
}) {
  const [modelos, setModelos] = useState<
    | {
        model: string;
        series: {
          serie: number;
          nextNumber: number;
          environment?: 'homologation' | 'production' | null;
          usadas?: { homologation: number; production: number };
        }[];
      }[]
    | null
  >(null);
  /*
    O AMBIENTE DA SÉRIE (auditoria P0 da Preço Justo). "Manter" não manda o
    campo, e o servidor não mexe no que está gravado — é o caminho de quem só
    avança o número. Os outros reservam a série: teste e produção em séries
    separadas, para a nota de teste não gastar o número que o contador definiu
    para a primeira nota de verdade.
  */
  const [form, setForm] = useState({ model: '65', serie: '1', nextNumber: '1', ambiente: 'manter' });
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setModelos(await coreApi.getFiscalSeries());
    } catch (err) {
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao ler as séries.');
    }
  }, [onErro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = useCallback(async () => {
    setBusy(true);
    try {
      // O texto vira número AQUI, e o servidor confere de novo: campo vazio é
      // NaN, e NaN chegava até o banco como "NOT NULL constraint failed".
      const environment =
        form.ambiente === 'manter'
          ? undefined
          : form.ambiente === 'ambos'
            ? null
            : (form.ambiente as 'homologation' | 'production');
      await coreApi.setFiscalSeries(form.model, Number(form.serie), Number(form.nextNumber), environment);
      await carregar();
      await onSalvo(`Série ${form.serie} do modelo ${form.model} salva.`);
    } catch (err) {
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar a série.');
    } finally {
      setBusy(false);
    }
  }, [form, carregar, onSalvo, onErro]);

  return (
    <Card
      title="Numeração das notas"
      subtitle="Cada modelo precisa de pelo menos uma série. A numeração só anda para frente."
    >
      <div className="flex flex-col gap-4">
        {modelos?.map((m) => (
          <div key={m.model}>
            <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)] m-0 mb-1">
              {MODELO_ROTULO[m.model] ?? `Modelo ${m.model}`}
            </p>
            {m.series.length === 0 ? (
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
                Nenhuma série configurada — a emissão deste modelo fica bloqueada.
              </p>
            ) : (
              <ul className="m-0 pl-4 text-[length:var(--gs-text-sm)] text-[var(--gs-text)]">
                {m.series.map((s) => (
                  <li key={s.serie}>
                    Série {s.serie} — próxima nota número {s.nextNumber}
                    {' · '}
                    {s.environment === 'production'
                      ? 'só produção'
                      : s.environment === 'homologation'
                        ? 'só homologação (testes)'
                        : 'serve aos dois ambientes'}
                    {s.usadas && (s.usadas.homologation > 0 || s.usadas.production > 0)
                      ? ` · já usadas: ${s.usadas.homologation} em homologação, ${s.usadas.production} em produção`
                      : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Modelo">
            {(props) => (
              <select
                {...props}
                value={form.model}
                onChange={(e) => setForm((a) => ({ ...a, model: e.target.value }))}
                className="w-full px-3 py-2 rounded-[var(--gs-radius)] border
                  border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                  text-[var(--gs-text)] text-[length:var(--gs-text-base)]"
              >
                <option value="65">NFC-e (cupom, modelo 65)</option>
                <option value="55">NF-e (modelo 55)</option>
              </select>
            )}
          </Field>
          <Field label="Série" hint="Inteiro de 0 a 999.">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={form.serie}
                onChange={(e) => setForm((a) => ({ ...a, serie: e.target.value }))}
              />
            )}
          </Field>
          <Field label="Próximo número" hint="Começa em 1. Não pode retroceder.">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={form.nextNumber}
                onChange={(e) => setForm((a) => ({ ...a, nextNumber: e.target.value }))}
              />
            )}
          </Field>
          <Field
            label="Ambiente da série"
            hint="Teste e produção em séries separadas: a nota de teste não gasta o número da produção."
          >
            {(props) => (
              <select
                {...props}
                value={form.ambiente}
                onChange={(e) => setForm((a) => ({ ...a, ambiente: e.target.value }))}
                className="w-full px-3 py-2 rounded-[var(--gs-radius)] border
                  border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                  text-[var(--gs-text)] text-[length:var(--gs-text-base)]"
              >
                <option value="manter">Manter como está (série nova: os dois)</option>
                <option value="production">Só produção</option>
                <option value="homologation">Só homologação (testes)</option>
                <option value="ambos">Os dois ambientes</option>
              </select>
            )}
          </Field>
        </div>

        <div>
          <Button loading={busy} onClick={() => void salvar()}>
            Salvar numeração
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * CSC — o segredo que assina o QR Code do cupom.
 *
 * O TOKEN SOBE E NÃO DESCE. O servidor guarda cifrado e devolve só o ID e o
 * "está configurado"; esta tela nunca tem como mostrar o token de volta, nem
 * por engano. Quem precisa trocar digita o novo.
 *
 * UM CSC PARA CADA AMBIENTE (GAP-PRD-022). A SEFAZ emite um código para
 * homologação e outro para produção, e o servidor guardava um só: gravar o de
 * produção apagava o de teste, e depois da virada o cupom saía com o de teste
 * enquanto esta tela dizia CONFIGURADO. O cartão mostra os dois lugares e diz
 * qual o cupom usa hoje.
 *
 * O ambiente de gravação COMEÇA no da operação — o caminho normal não pede
 * escolha, e é assim que o de teste não vira "de produção" por descuido. Mas o
 * de produção pode ser gravado ANTES da virada: era o que o dia da troca
 * precisava para não depender de variável no servidor nem de reinício.
 */
const AMBIENTES_DO_CSC = ['homologation', 'production'] as const;
type AmbienteDoCsc = (typeof AMBIENTES_DO_CSC)[number];

const ROTULO_DO_AMBIENTE: Record<AmbienteDoCsc, string> = {
  homologation: 'homologação',
  production: 'produção',
};

const TITULO_DO_AMBIENTE: Record<AmbienteDoCsc, string> = {
  homologation: 'Homologação',
  production: 'Produção',
};

function CscCard({
  ambiente,
  onSalvo,
  onErro,
}: {
  ambiente: AmbienteDoCsc;
  onSalvo: (mensagem: string) => Promise<void>;
  onErro: (mensagem: string) => void;
}) {
  const [atual, setAtual] = useState<NfceCscSetting[] | null>(null);
  /*
    O SELO SÓ AFIRMA O QUE LEU (auditoria P0 da Preço Justo).

    Sem a lista do cofre, `atual` ficava `null`, `doAmbiente` devolvia
    `undefined` e os dois selos diziam NÃO CONFIGURADO — enquanto a leitura não
    chegava e, quando ela era recusada, para sempre. O `gerente_oficina` abre
    esta tela (o GET da configuração o admite), mas o GET do CSC é só da
    gerência da loja: ele via os dois ambientes "não configurados" com o código
    gravado no cofre. Sem leitura, o selo diz que não sabe — como o
    `AmbienteCard` faz com o ambiente desconhecido.
  */
  const [leituraFalhou, setLeituraFalhou] = useState(false);
  const [cscId, setCscId] = useState('');
  const [cscToken, setCscToken] = useState('');
  const [destino, setDestino] = useState<AmbienteDoCsc>(ambiente);
  const [busy, setBusy] = useState(false);

  // A operação virou de ambiente: o formulário volta a apontar para ele.
  useEffect(() => {
    setDestino(ambiente);
  }, [ambiente]);

  const carregar = useCallback(async () => {
    try {
      setAtual(await coreApi.getNfceCsc());
      setLeituraFalhou(false);
    } catch (err) {
      // A última lista lida (se houver) continua valendo; sem nenhuma, o selo
      // passa a dizer que não sabe.
      setLeituraFalhou(true);
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao ler o CSC.');
    }
  }, [onErro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = useCallback(async () => {
    setBusy(true);
    try {
      await coreApi.setNfceCsc({ cscId, cscToken, environment: destino }, `csc-${uuid()}`);
      // O campo do token é limpo no sucesso: ele não fica na tela depois de
      // gravado, e não há motivo para o navegador continuar segurando o valor.
      setCscToken('');
      await carregar();
      await onSalvo(`CSC de ${ROTULO_DO_AMBIENTE[destino]} gravado no cofre.`);
    } catch (err) {
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao gravar o CSC.');
    } finally {
      setBusy(false);
    }
  }, [cscId, cscToken, destino, carregar, onSalvo, onErro]);

  const doAmbiente = (a: AmbienteDoCsc) =>
    atual?.find((c) => c.environment === a && c.configured);
  const outro: AmbienteDoCsc = ambiente === 'production' ? 'homologation' : 'production';
  // O caso do dia da virada: há um código no cofre, e é o do OUTRO ambiente.
  const soOOutro = atual !== null && !doAmbiente(ambiente) ? doAmbiente(outro) : undefined;

  return (
    <Card
      title="CSC (código de segurança do contribuinte)"
      subtitle="Sem ele o cupom não tem QR Code — e sem QR Code o cupom não vale. Vem do portal da SEFAZ do seu estado, um para cada ambiente."
    >
      <div className="flex flex-col gap-4">
        <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label="CSC por ambiente">
          {AMBIENTES_DO_CSC.map((a) => {
            const gravado = doAmbiente(a);
            return (
              <li key={a} className="flex items-center gap-3 flex-wrap">
                <span className="font-semibold min-w-[7rem]">{TITULO_DO_AMBIENTE[a]}</span>
                {atual === null ? (
                  <Badge tone="neutral">
                    {leituraFalhou ? 'SITUAÇÃO DESCONHECIDA' : 'CONSULTANDO…'}
                  </Badge>
                ) : gravado ? (
                  <Badge tone="success">CONFIGURADO</Badge>
                ) : (
                  <Badge tone={a === ambiente ? 'warning' : 'neutral'}>NÃO CONFIGURADO</Badge>
                )}
                {gravado && (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    CSC ID {gravado.cscId}
                  </span>
                )}
                {a === ambiente && (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    · é o que o cupom usa hoje
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {soOOutro && (
          <p
            role="alert"
            className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] font-semibold"
          >
            Esta operação emite em {ROTULO_DO_AMBIENTE[ambiente]} e só o CSC de{' '}
            {ROTULO_DO_AMBIENTE[outro]} está gravado (CSC ID {soOOutro.cscId}). O cupom não sai até
            o CSC de {ROTULO_DO_AMBIENTE[ambiente]} ser gravado — a SEFAZ emite um código para cada
            ambiente.
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="CSC ID" hint="O identificador numérico, normalmente 000001.">
            {(props) => (
              <Input {...props} value={cscId} onChange={(e) => setCscId(e.target.value)} />
            )}
          </Field>
          <Field
            label="Token do CSC"
            hint="Gravado cifrado. Não volta para a tela depois de salvo."
          >
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="off"
                value={cscToken}
                onChange={(e) => setCscToken(e.target.value)}
              />
            )}
          </Field>
        </div>

        <Field
          label="Ambiente do CSC"
          hint="Começa no ambiente da operação. O de produção pode ser gravado antes da virada."
        >
          {(props) => (
            <select
              {...props}
              value={destino}
              onChange={(e) =>
                setDestino(e.target.value === 'production' ? 'production' : 'homologation')
              }
              className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
            >
              <option value="homologation">Homologação</option>
              <option value="production">Produção</option>
            </select>
          )}
        </Field>

        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          {destino === ambiente ? (
            <>
              Será gravado para o ambiente de <strong>{ROTULO_DO_AMBIENTE[ambiente]}</strong>, que
              é o ambiente desta operação hoje.
            </>
          ) : (
            <>
              Será gravado para <strong>{ROTULO_DO_AMBIENTE[destino]}</strong> e fica guardado:
              enquanto esta operação emitir em {ROTULO_DO_AMBIENTE[ambiente]}, o cupom continua
              usando o CSC de {ROTULO_DO_AMBIENTE[ambiente]}.
            </>
          )}
        </p>

        <div>
          <Button
            loading={busy}
            disabled={!cscId.trim() || !cscToken.trim()}
            onClick={() => void salvar()}
          >
            Gravar CSC
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * ============================================================================
 * O ASSISTENTE DE PRONTIDÃO — o checklist que responde, e não só cobra
 * ============================================================================
 *
 * A lista antiga dizia PASS ou FAIL e uma frase. Quem a lia ficava sem as
 * quatro respostas que decidem o que fazer a seguir: o que já sabemos, de onde
 * veio o dado, quem resolve, e quanto falta. Sem o DONO do item, a tela
 * empurrava o gestor a procurar por horas um botão para resolver o que só a
 * SEFAZ resolve. Sem a PROCEDÊNCIA, um NCM lido do arquivo de um fornecedor
 * parecia decisão da casa.
 *
 * O estado e o status são EIXOS DIFERENTES, e a tela mostra os dois: o ✓/•/✕
 * continua sendo o portão da emissão; o selo ao lado do rótulo é o que a
 * pessoa precisa saber para agir.
 */
const ESTADO_ROTULO: Record<
  ReadinessState,
  { texto: string; tom: 'neutral' | 'warning' | 'success' | 'danger' }
> = {
  CONFIRMADO: { texto: 'CONFIRMADO', tom: 'success' },
  AUTO_DETECTADO: { texto: 'AUTO-DETECTADO', tom: 'warning' },
  PENDENTE: { texto: 'PENDENTE', tom: 'neutral' },
  DIVERGENTE: { texto: 'DIVERGENTE', tom: 'danger' },
  NAO_APLICAVEL: { texto: 'NÃO APLICÁVEL', tom: 'neutral' },
  BLOQUEADO_EXTERNAMENTE: { texto: 'BLOQUEADO FORA DAQUI', tom: 'neutral' },
};

const PROCEDENCIA_ROTULO: Record<ReadinessSource, string> = {
  cadastro: 'do cadastro',
  certificado: 'lido do certificado',
  xml_fornecedor: 'sugerido pelo XML do fornecedor',
  confirmacao_humana: 'confirmado por uma pessoa',
  sefaz: 'resposta da SEFAZ',
  cofre: 'guardado no cofre',
};

const DONO_ROTULO: Record<ReadinessOwner, string> = {
  dono: 'resolve: o dono do sistema',
  gestor: 'resolve: a gerência da operação',
  contador: 'resolve: o contador',
  sefaz: 'resolve: a SEFAZ — não há o que fazer aqui',
};

/**
 * ONDE SE RESOLVE — o atalho para a tela do item (GAP-PRD-095/129).
 *
 * "Resolve: o contador" diz QUEM; faltava dizer ONDE. A tributação e a
 * classificação vivem em telas do Catálogo, e quem lê o checklist aqui não
 * tinha como chegar lá sem saber o caminho de cor.
 */
const ONDE_SE_RESOLVE: Partial<Record<string, { rotulo: string; para: string }>> = {
  product_tax_group: {
    rotulo: 'Abrir Catálogo › Grupos tributários',
    para: '/sistema/produtos/auxiliares?aba=tributarios',
  },
  product_ncm: { rotulo: 'Classificar na alteração rápida', para: '/sistema/produtos/alteracao-rapida' },
  product_cfop: { rotulo: 'Classificar na alteração rápida', para: '/sistema/produtos/alteracao-rapida' },
  product_origin: {
    rotulo: 'Classificar na alteração rápida',
    para: '/sistema/produtos/alteracao-rapida',
  },
};

function ChecklistCard({ relatorio }: { relatorio: ReadinessReport }) {
  const selo = READINESS_ROTULO[relatorio.readiness];
  const faltam = relatorio.items.filter((i) => i.status === 'FAIL').length;

  return (
    <Card
      title={MODELO_ROTULO[relatorio.model] ?? `Modelo ${relatorio.model}`}
      subtitle={
        relatorio.canEmit
          ? 'Configuração completa.'
          : `${faltam} pendência(s) impedem a emissão.`
      }
    >
      <div className="mb-4">
        <Badge tone={selo?.tom ?? 'neutral'}>{selo?.texto ?? relatorio.readiness}</Badge>
      </div>

      <ul className="list-none p-0 m-0 flex flex-col gap-3">
        {relatorio.items.map((item) => {
          const estado = ESTADO_ROTULO[item.state] ?? ESTADO_ROTULO.PENDENTE;
          return (
            <li key={item.key} className="flex gap-3 items-start">
              <span
                aria-hidden
                className={`mt-0.5 font-bold ${
                  item.status === 'PASS'
                    ? 'text-[var(--gs-success)]'
                    : item.status === 'PENDING'
                      ? 'text-[var(--gs-warning)]'
                      : 'text-[var(--gs-danger)]'
                }`}
              >
                {item.status === 'PASS' ? '✓' : item.status === 'PENDING' ? '•' : '✕'}
              </span>
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[length:var(--gs-text-base)] flex items-center gap-2 flex-wrap">
                  {item.label}
                  <Badge tone={estado.tom}>{estado.texto}</Badge>
                  <span className="sr-only">
                    {item.status === 'PASS'
                      ? ' — ok'
                      : item.status === 'PENDING'
                        ? ' — pendente'
                        : ' — falta'}
                  </span>
                </span>

                {/* O QUE JÁ SABEMOS. Sem isto, "Razão social ✓" não diz QUAL. */}
                {item.known && (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-900)] font-semibold break-words">
                    {item.known}
                  </span>
                )}

                {/*
                  QUANTOS DE QUANTOS. "12 sem NCM" é um susto sem tamanho;
                  "12 de 4 000, 99% classificados" é uma tarde de trabalho.
                */}
                {item.counts && item.counts.total > 0 && (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {item.counts.done} de {item.counts.total} ({item.counts.percent}%)
                  </span>
                )}

                {item.detail && (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {item.detail}
                  </span>
                )}

                {/* DE ONDE VEIO e QUEM RESOLVE, na mesma linha discreta. */}
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] italic">
                  {item.source ? `${PROCEDENCIA_ROTULO[item.source]} · ` : ''}
                  {DONO_ROTULO[item.owner]}
                </span>

                {/* E ONDE: o atalho para a tela em que o item se resolve. */}
                {item.status !== 'PASS' && ONDE_SE_RESOLVE[item.key] && (
                  <Link
                    to={ONDE_SE_RESOLVE[item.key]!.para}
                    className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-purple-800)] underline"
                  >
                    {ONDE_SE_RESOLVE[item.key]!.rotulo}
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * ============================================================================
 * O QUE O XML DO FORNECEDOR JÁ RESPONDEU
 * ============================================================================
 *
 * A regra mestre: se o sistema consegue descobrir com segurança, ele não
 * pergunta. O NCM, o CEST e a origem de cada mercadoria chegam ESCRITOS nos
 * XMLs de entrada — e o contador os redigitava, produto a produto, num
 * formulário.
 *
 * Este cartão não decide nada. Ele mostra o que o arquivo disse, com
 * procedência e contagem (dois fornecedores que concordam valem mais que um),
 * e oferece UM CLIQUE para confirmar tudo que é inequívoco. O que ele nunca
 * faz:
 *
 *   - aplicar em silêncio a produto já confirmado — a decisão anterior tem
 *     autor e data, e arquivo de terceiro não a revoga;
 *   - escolher entre valores em conflito — isso é decisão, e decisão é de
 *     gente. A divergência aparece com os dois valores e quem os declarou;
 *   - tocar em CFOP, CSOSN ou pCredSN. O CFOP do arquivo é a SAÍDA DO
 *     FORNECEDOR, nunca a nossa.
 */
function SugestoesDoXmlCard({
  resumo,
  onConfirmado,
  onErro,
}: {
  resumo: ClassificationSummary | null;
  onConfirmado: () => Promise<void>;
  onErro: (mensagem: string) => void;
}) {
  const [itens, setItens] = useState<ProductClassification[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** O que a última releitura das notas achou (GAP-PRD-181). */
  const [releitura, setReleitura] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const res = await coreApi.listProductClassifications();
      setItens(res.items);
    } catch (err) {
      setItens([]);
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao ler as sugestões fiscais.');
    }
  }, [onErro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const confirmarTudo = useCallback(async () => {
    setBusy(true);
    try {
      const res = await coreApi.confirmProductClassification();
      await carregar();
      await onConfirmado();
      if (res.confirmed === 0) {
        onErro('Nada inequívoco a confirmar. As divergências precisam de escolha item a item.');
      }
    } catch (err) {
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao confirmar.');
    } finally {
      setBusy(false);
    }
  }, [carregar, onConfirmado, onErro]);

  const escolher = useCallback(
    async (productId: string, field: CampoFiscal, value: string) => {
      setBusy(true);
      try {
        await coreApi.confirmProductClassification([{ productId, field, value }]);
        await carregar();
        await onConfirmado();
      } catch (err) {
        onErro(err instanceof ApiRequestError ? err.message : 'Falha ao confirmar.');
      } finally {
        setBusy(false);
      }
    },
    [carregar, onConfirmado, onErro],
  );

  /*
    RELER AS NOTAS JÁ RECEBIDAS (GAP-PRD-181).

    A nota que entrou antes do recurso de sugestão nunca gerou sugestão — e
    o cartão vazio é exatamente o caso dela. O botão mora nos dois estados do
    cartão por isso. O servidor completa só o que está nulo; nada é
    confirmado: o que a releitura achar aparece aqui embaixo para alguém
    dizer "sim".
  */
  const relerNotas = useCallback(async () => {
    setBusy(true);
    setReleitura(null);
    try {
      setReleitura(fraseDaReleitura(await releituraDoXmlApi.reler()));
      await carregar();
      await onConfirmado();
    } catch (err) {
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao reler as notas.');
    } finally {
      setBusy(false);
    }
  }, [carregar, onConfirmado, onErro]);

  const botaoReler = (
    <Button size="sm" variant="secondary" loading={busy} onClick={() => void relerNotas()}>
      Reler as notas já recebidas
    </Button>
  );

  const avisoDaReleitura = releitura ? (
    <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-success)] mt-0 mb-4">
      {releitura}
    </p>
  ) : null;

  const aplicaveis = (itens ?? []).reduce((soma, p) => soma + p.applicable.length, 0);

  /*
    NADA A MOSTRAR É UMA RESPOSTA, e não um cartão vazio: dizer "nenhuma
    sugestão pendente" evita que quem procura a funcionalidade conclua que ela
    não existe — o mesmo motivo pelo qual as pendências de produto têm um
    estado vazio explícito logo abaixo.
  */
  if (itens && itens.length === 0) {
    return (
      <Card
        title="Sugestões do XML do fornecedor"
        subtitle="Nenhuma classificação sugerida esperando confirmação."
        actions={botaoReler}
      >
        {avisoDaReleitura}
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          A cada nota de entrada, o NCM, o CEST e a origem declarados pelo fornecedor viram
          sugestão para o produto casado. Nada é aplicado sozinho: o que aparece aqui é o que
          está esperando alguém dizer "sim".
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Sugestões do XML do fornecedor"
      subtitle={
        itens
          ? `${itens.length} produto(s) com classificação vinda de nota de entrada.`
          : 'Carregando…'
      }
      actions={
        <div className="flex gap-2 flex-wrap">
          {botaoReler}
          {aplicaveis > 0 && (
            <Button size="sm" loading={busy} onClick={() => void confirmarTudo()}>
              Confirmar {aplicaveis} sugestão(ões)
            </Button>
          )}
        </div>
      }
    >
      {avisoDaReleitura}
      {resumo && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-4">
          {resumo.withNcm} de {resumo.totalProducts} produto(s) com NCM ·{' '}
          {resumo.confirmed} confirmado(s) por uma pessoa ·{' '}
          {resumo.divergences} com divergência.
        </p>
      )}

      {/*
        A FRASE QUE PRECISA FICAR ESCRITA NA TELA, e não só no código: o XML do
        fornecedor descreve a MERCADORIA, nunca a tributação da NOSSA saída.
      */}
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-4">
        Sugestão não é confirmação. CSOSN, CFOP e pCredSN continuam sendo decisão do contador —
        o XML do fornecedor traz a operação de saída DELE, não a nossa.
      </p>

      {itens && (
        <DataTable
          rows={itens}
          keyOf={(p) => p.productId}
          columns={[
            {
              header: 'Produto',
              render: (p) => (
                <div className="flex flex-col">
                  <span className="font-semibold text-[var(--gs-purple-900)]">{p.name}</span>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {p.sku || p.internalCode || '—'}
                  </span>
                </div>
              ),
            },
            {
              header: 'Classificação sugerida',
              render: (p) => (
                <div className="flex flex-col gap-2">
                  {p.fields
                    .filter((f) => f.evidence.length > 0)
                    .map((f) => (
                      <div key={f.field} className="flex flex-col gap-1">
                        <span className="text-[length:var(--gs-text-sm)] flex items-center gap-2 flex-wrap">
                          <strong className="uppercase">{f.field}</strong>
                          <Badge tone={ESTADO_ROTULO[f.state].tom}>
                            {ESTADO_ROTULO[f.state].texto}
                          </Badge>
                          {f.current && (
                            <span className="text-[var(--gs-muted)]">
                              cadastro: {f.current}
                            </span>
                          )}
                        </span>
                        {f.evidence.map((e) => (
                          <span
                            key={e.value}
                            className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]
                              flex items-center gap-2 flex-wrap"
                          >
                            <code>{e.value}</code>
                            {/* A CONTAGEM É A CONFIANÇA. Duas notas que dizem o
                                mesmo valem mais que uma — e o número é o que
                                permite a quem confirma medir isso. */}
                            <span>
                              {e.occurrences} nota(s)
                              {e.suppliers.length > 0 ? ` · ${e.suppliers.join(', ')}` : ''}
                            </span>
                            {f.state === 'DIVERGENTE' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={busy}
                                onClick={() => void escolher(p.productId, f.field, e.value)}
                              >
                                Usar este
                              </Button>
                            )}
                          </span>
                        ))}
                      </div>
                    ))}
                </div>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}

/**
 * Produtos que bloqueiam a emissão.
 *
 * A tela NÃO sugere valores. NCM e CFOP são classificação fiscal: um palpite
 * "provável" produz nota autorizada com tributação errada — pior que nota
 * recusada, porque a recusa aparece na hora e o imposto errado aparece na
 * fiscalização.
 *
 * O que ela faz é dizer, produto a produto, exatamente qual campo falta, e
 * deixar quem sabe a resposta preencher ali mesmo.
 */
function PendenciasProdutosCard({ onCorrigido }: { onCorrigido: () => Promise<void> }) {
  const [itens, setItens] = useState<ProductFiscalPendency[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState({ ncm: '', cfop: '', origin: '', cest: '' });
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setItens(await coreApi.listProductFiscalPendencies());
    } catch (err) {
      setItens(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar pendências.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = useCallback(
    async (id: string) => {
      setBusy(true);
      setErro(null);
      try {
        await coreApi.updateProductFiscal(id, {
          ncm: rascunho.ncm || undefined,
          cfop: rascunho.cfop || undefined,
          origin: rascunho.origin || undefined,
          cest: rascunho.cest || undefined,
        });
        setEditando(null);
        await carregar();
        await onCorrigido();
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
      } finally {
        setBusy(false);
      }
    },
    [rascunho, carregar, onCorrigido],
  );

  if (itens && itens.length === 0) {
    return (
      <Card title="Produtos" subtitle="Nenhum produto ativo bloqueia a emissão.">
        <p className="text-[length:var(--gs-text-base)] text-[var(--gs-success)] font-semibold m-0">
          Classificação fiscal completa.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Pendências fiscais de produtos"
      subtitle={
        itens
          ? `${itens.length} produto(s) ativo(s) impedem a emissão fiscal.`
          : 'Carregando…'
      }
    >
      {erro && (
        <p
          role="alert"
          className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      {itens && (
        <DataTable
          rows={itens}
          keyOf={(p) => p.id}
          columns={[
            {
              header: 'Produto',
              render: (p) => (
                <div className="flex flex-col">
                  <span className="font-semibold text-[var(--gs-purple-900)]">{p.name}</span>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {p.sku || p.internalCode || '—'}
                  </span>
                </div>
              ),
            },
            {
              header: 'Falta',
              render: (p) => (
                <div className="flex flex-wrap gap-1">
                  {p.missing.map((m) => (
                    <Badge key={m} tone="danger">
                      {m}
                    </Badge>
                  ))}
                </div>
              ),
            },
            {
              header: 'NCM',
              render: (p) => p.ncm || '—',
            },
            {
              header: 'CFOP',
              render: (p) => p.cfop || '—',
            },
            {
              header: 'Origem',
              render: (p) => p.origin || '—',
            },
            {
              header: 'Ação',
              align: 'right',
              render: (p) =>
                editando === p.id ? (
                  <div className="flex gap-2 justify-end flex-wrap">
                    <Input
                      value={rascunho.ncm}
                      onChange={(e) => setRascunho((r) => ({ ...r, ncm: e.target.value }))}
                      placeholder="NCM (8)"
                      aria-label={`NCM de ${p.name}`}
                      className="w-28"
                    />
                    <Input
                      value={rascunho.cfop}
                      onChange={(e) => setRascunho((r) => ({ ...r, cfop: e.target.value }))}
                      placeholder="CFOP (4)"
                      aria-label={`CFOP de ${p.name}`}
                      className="w-24"
                    />
                    <Input
                      value={rascunho.origin}
                      onChange={(e) => setRascunho((r) => ({ ...r, origin: e.target.value }))}
                      placeholder="Origem"
                      aria-label={`Origem de ${p.name}`}
                      className="w-24"
                    />
                    <Button size="sm" loading={busy} onClick={() => void salvar(p.id)}>
                      Salvar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditando(null)}>
                      Cancelar
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditando(p.id);
                      setRascunho({
                        ncm: p.ncm ?? '',
                        cfop: p.cfop ?? '',
                        origin: p.origin ?? '',
                        cest: p.cest ?? '',
                      });
                    }}
                  >
                    Classificar
                  </Button>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}

/**
 * OS QUATRO CRT DO LEIAUTE (GAP-PRD-021).
 *
 * O campo era texto livre com a dica "1 · 2 · 3": "simples" ou "5" eram
 * gravados, e o 4 (MEI) nem aparecia. O servidor agora recusa o que não é do
 * leiaute; a tela oferece só o que ele aceita.
 */
const CRTS: { valor: string; rotulo: string }[] = [
  { valor: '', rotulo: '— (o contador informa)' },
  { valor: '1', rotulo: '1 — Simples Nacional' },
  { valor: '2', rotulo: '2 — Simples Nacional, excesso de sublimite' },
  { valor: '3', rotulo: '3 — Regime normal' },
  { valor: '4', rotulo: '4 — MEI' },
];

/** Dados do emitente. Cada operação emite com o próprio CNPJ — não há fallback. */
function EmitenteCard({
  config,
  onSalvo,
  onErro,
}: {
  config: FiscalConfig;
  onSalvo: (mensagem: string) => Promise<void>;
  onErro: (mensagem: string) => void;
}) {
  const [form, setForm] = useState({
    legalName: config.legalName ?? '',
    tradeName: config.tradeName ?? '',
    cnpj: config.cnpj ?? '',
    ie: config.ie ?? '',
    crt: config.crt ?? '',
    zip: config.zip ?? '',
    street: config.street ?? '',
    number: config.number ?? '',
    complement: config.complement ?? '',
    district: config.district ?? '',
    cityName: config.cityName ?? '',
    cityIbge: config.cityIbge ?? '',
    uf: config.uf ?? '',
    phone: config.phone ?? '',
  });
  const [busy, setBusy] = useState(false);
  // Com a tabela de municípios do IBGE carregada, o município é escolhido pelo
  // nome e o código vem junto (IBGE-MUNICIPIOS); sem ela, os campos digitados.
  const tabelaDeMunicipios = useTabelaDeMunicipios();
  const ufDoEmitente = form.uf.trim().toUpperCase();

  const set = (chave: keyof typeof form) => (valor: string) =>
    setForm((atual) => ({ ...atual, [chave]: valor }));

  const salvar = useCallback(async () => {
    setBusy(true);
    try {
      await coreApi.updateFiscalConfig(form);
      await onSalvo('Configuração salva.');
    } catch (err) {
      onErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setBusy(false);
    }
  }, [form, onSalvo, onErro]);

  const campo = (chave: keyof typeof form, rotulo: string, dica?: string) => (
    <Field label={rotulo} hint={dica}>
      {(props) => (
        <Input {...props} value={form[chave]} onChange={(e) => set(chave)(e.target.value)} />
      )}
    </Field>
  );

  return (
    <Card
      title="Emitente"
      subtitle="Cada operação emite com o próprio CNPJ. Não existe emitente padrão."
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {campo('legalName', 'Razão social')}
          {campo('tradeName', 'Nome fantasia')}
          {campo('cnpj', 'CNPJ', 'Os dígitos verificadores são conferidos ao salvar.')}
          {campo('ie', 'Inscrição estadual')}
          <Field
            label="CRT"
            hint="Decide se o item sai por CSOSN (1, 2 e 4) ou por CST de ICMS (3)."
          >
            {(props) => (
              <select
                {...props}
                value={form.crt}
                onChange={(e) => set('crt')(e.target.value)}
                className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
              >
                {CRTS.map((c) => (
                  <option key={c.valor} value={c.valor}>
                    {c.rotulo}
                  </option>
                ))}
                {/* Banco herdado com CRT fora do leiaute: aparece, para ser corrigido. */}
                {form.crt && !CRTS.some((c) => c.valor === form.crt) && (
                  <option value={form.crt}>{form.crt} — fora do leiaute (corrija)</option>
                )}
              </select>
            )}
          </Field>
          {campo('phone', 'Telefone')}
        </div>

        {/*
          O REGIME NORMAL SAI (GAP-PRD-021) — e depende do grupo. Dizer aqui é o
          que evita descobrir na primeira venda que o CST 00 pede alíquota.
        */}
        {form.crt === '3' && (
          <p
            role="note"
            className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]"
          >
            Regime normal: cada item sai com o CST de ICMS do grupo tributário, e os CST 00 e 20
            exigem a alíquota de ICMS escolhida no grupo (Catálogo › Grupos tributários). A
            substituição tributária calculada por esta empresa (CST 10, 30 e 70) não é emitida: o
            ICMS-ST é cobrado por fora.
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {campo('zip', 'CEP')}
          {campo('street', 'Logradouro')}
          {campo('number', 'Número')}
          {campo('complement', 'Complemento')}
          {campo('district', 'Bairro')}
          {tabelaDeMunicipios === 'carregada' ? (
            <>
              <Field label="UF">
                {(props) => (
                  <select
                    {...props}
                    value={ufDoEmitente}
                    onChange={(e) => setForm((atual) => ({ ...atual, uf: e.target.value, cityIbge: '' }))}
                    className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                  >
                    <option value="">Escolha a UF</option>
                    {UFS.map((uf) => (
                      <option key={uf} value={uf}>
                        {uf}
                      </option>
                    ))}
                    {ufDoEmitente && !UFS.includes(ufDoEmitente) && (
                      <option value={ufDoEmitente}>{ufDoEmitente} (corrija)</option>
                    )}
                  </select>
                )}
              </Field>
              <Field
                label="Município"
                hint={
                  form.cityIbge
                    ? `Código IBGE ${form.cityIbge} (veio com o município escolhido).`
                    : 'Escolha o município na lista: o código IBGE vem junto.'
                }
              >
                {(props) => (
                  <CidadeComSugestoes
                    {...props}
                    uf={ufDoEmitente}
                    valor={form.cityName}
                    onDigitar={(nome) => setForm((atual) => ({ ...atual, cityName: nome, cityIbge: '' }))}
                    onEscolher={(m) =>
                      setForm((atual) => ({ ...atual, cityName: m.nome, uf: m.uf, cityIbge: m.codigo }))
                    }
                    className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                      bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]
                      placeholder:text-[var(--gs-muted)] focus:border-[var(--gs-purple-700)]"
                  />
                )}
              </Field>
            </>
          ) : (
            <>
              {campo('cityName', 'Município')}
              {campo('cityIbge', 'Código IBGE', '7 dígitos.')}
              {campo('uf', 'UF')}
            </>
          )}
        </div>

        <div>
          <Button loading={busy} onClick={() => void salvar()}>
            Salvar configuração
          </Button>
        </div>
      </div>
    </Card>
  );
}
